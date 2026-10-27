from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import numpy as np
import optuna
import pandas as pd
from catboost import CatBoostClassifier, CatBoostRegressor
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import KFold, StratifiedKFold


def _resolve_existing_csv(p: Path, label: str) -> Path:
    rp = p.expanduser().resolve()
    if rp.is_file():
        return rp
    cwd_csv = sorted(Path.cwd().glob("*.csv"))
    sample = ", ".join(x.name for x in cwd_csv[:8]) if cwd_csv else "нет CSV в текущей папке"
    raise FileNotFoundError(
        f"{label} CSV не найден: '{p}'. Укажи полный путь к файлу. "
        f"Текущая папка: {Path.cwd()}. Найдено рядом: {sample}"
    )


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="v10 Optuna pipeline: CatBoost + CV + submission_primary.csv"
    )
    p.add_argument("--train", type=Path, required=True, help="Path to train CSV")
    p.add_argument("--test", type=Path, required=True, help="Path to test CSV")
    p.add_argument("--target", type=str, required=True, help="Target column in train CSV")
    p.add_argument("--id-col", type=str, default="id", help="ID column for submission")
    p.add_argument("--trials", type=int, default=80, help="Optuna trials (slow=80-150)")
    p.add_argument("--folds", type=int, default=5, help="CV folds")
    p.add_argument("--seed", type=int, default=42, help="Random seed")
    p.add_argument(
        "--metric",
        type=str,
        default="auto",
        choices=("auto", "auc", "rmse"),
        help="Optimization metric",
    )
    p.add_argument(
        "--output",
        type=Path,
        default=Path("submission_primary.csv"),
        help="Submission output file",
    )
    return p.parse_args()


def detect_task(y: pd.Series, metric: str) -> str:
    if metric == "auc":
        return "classification"
    if metric == "rmse":
        return "regression"
    y_non_na = y.dropna()
    unique_count = y_non_na.nunique()
    if unique_count <= 20 and sorted(y_non_na.unique().tolist()) in ([0, 1], [0], [1]):
        return "classification"
    return "regression"


def split_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[int]]:
    cat_cols = [
        c
        for c in df.columns
        if pd.api.types.is_object_dtype(df[c])
        or pd.api.types.is_categorical_dtype(df[c])
        or pd.api.types.is_bool_dtype(df[c])
    ]
    cat_idx = [df.columns.get_loc(c) for c in cat_cols]
    return df, cat_idx


def cv_score(
    X: pd.DataFrame,
    y: pd.Series,
    *,
    task: str,
    params: dict[str, Any],
    folds: int,
    seed: int,
) -> float:
    X, cat_idx = split_features(X)

    if task == "classification":
        cv = StratifiedKFold(n_splits=folds, shuffle=True, random_state=seed)
    else:
        cv = KFold(n_splits=folds, shuffle=True, random_state=seed)

    scores: list[float] = []
    for tr_idx, va_idx in cv.split(X, y):
        X_tr, X_va = X.iloc[tr_idx], X.iloc[va_idx]
        y_tr, y_va = y.iloc[tr_idx], y.iloc[va_idx]

        if task == "classification":
            model = CatBoostClassifier(
                **params,
                random_seed=seed,
                verbose=False,
                loss_function="Logloss",
            )
            model.fit(X_tr, y_tr, cat_features=cat_idx)
            proba = model.predict_proba(X_va)[:, 1]
            scores.append(float(roc_auc_score(y_va, proba)))
        else:
            model = CatBoostRegressor(
                **params,
                random_seed=seed,
                verbose=False,
                loss_function="RMSE",
            )
            model.fit(X_tr, y_tr, cat_features=cat_idx)
            pred = model.predict(X_va)
            rmse = float(np.sqrt(np.mean((pred - y_va.values) ** 2)))
            scores.append(rmse)

    return float(np.mean(scores))


def main() -> None:
    args = parse_args()

    train_path = _resolve_existing_csv(args.train, "Train")
    test_path = _resolve_existing_csv(args.test, "Test")
    train_df = pd.read_csv(train_path)
    test_df = pd.read_csv(test_path)
    if args.target not in train_df.columns:
        raise ValueError(f"Target column '{args.target}' not found in train CSV.")
    if args.id_col not in test_df.columns:
        raise ValueError(f"ID column '{args.id_col}' not found in test CSV.")

    y = train_df[args.target]
    X = train_df.drop(columns=[args.target])
    X_test = test_df.copy()
    if args.target in X_test.columns:
        X_test = X_test.drop(columns=[args.target])

    task = detect_task(y, args.metric)
    direction = "maximize" if task == "classification" else "minimize"

    def objective(trial: optuna.Trial) -> float:
        params = {
            "depth": trial.suggest_int("depth", 3, 5),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.2, log=True),
            "l2_leaf_reg": trial.suggest_float("l2_leaf_reg", 1.0, 20.0, log=True),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bylevel": trial.suggest_float("colsample_bylevel", 0.6, 1.0),
            "min_data_in_leaf": trial.suggest_int("min_data_in_leaf", 1, 64),
            "iterations": trial.suggest_int("iterations", 400, 1800),
        }
        return cv_score(
            X,
            y,
            task=task,
            params=params,
            folds=args.folds,
            seed=args.seed,
        )

    study = optuna.create_study(direction=direction, study_name="v10_optuna_catboost")
    study.optimize(objective, n_trials=args.trials, show_progress_bar=True)

    best = study.best_trial
    print(f"Best {('AUC' if task == 'classification' else 'RMSE')}: {best.value:.6f}")
    print("Best params:", best.params)

    X_fit, cat_idx = split_features(X)
    if task == "classification":
        model = CatBoostClassifier(
            **best.params,
            random_seed=args.seed,
            verbose=False,
            loss_function="Logloss",
        )
        model.fit(X_fit, y, cat_features=cat_idx)
        preds = model.predict_proba(X_test)[:, 1]
    else:
        model = CatBoostRegressor(
            **best.params,
            random_seed=args.seed,
            verbose=False,
            loss_function="RMSE",
        )
        model.fit(X_fit, y, cat_features=cat_idx)
        preds = model.predict(X_test)

    submission = pd.DataFrame(
        {
            args.id_col: test_df[args.id_col],
            args.target: preds,
        }
    )
    submission.to_csv(args.output, index=False)
    print(f"Saved: {args.output.resolve()}")


if __name__ == "__main__":
    main()
