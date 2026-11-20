from app.wikirag_context_budget import (
    estimate_messages_tokens,
    estimate_tokens,
    human_lm_studio_error,
    is_context_overflow_error,
    shrink_messages,
    shrink_user_content,
)


def test_estimate_tokens_positive():
    assert estimate_tokens("abc") >= 1


def test_context_overflow_detection():
    err = "request (5451 tokens) exceeds the available context size (4096 tokens)"
    assert is_context_overflow_error(err)
    msg = human_lm_studio_error(400, err)
    assert "контекст" in msg.lower() or "20" in msg
    ollama_msg = human_lm_studio_error(400, err, provider="ollama")
    assert "ollama" in ollama_msg.lower() or "num_ctx" in ollama_msg.lower()
    assert "настройки" in ollama_msg.lower() or "llm" in ollama_msg.lower()


def test_human_error_status_zero_no_http_zero():
    msg = human_lm_studio_error(0, "connection refused", provider="ollama")
    assert "HTTP 0" not in msg
    assert "Ollama" in msg

def test_shrink_messages_reduces_tokens():
    long_body = "Данные CORAX\n" + ("x" * 8000) + "\n\nВопрос: тест?"
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": long_body},
    ]
    before = estimate_messages_tokens(messages)
    after = estimate_messages_tokens(shrink_messages(messages))
    assert after < before


def test_shrink_user_content_removes_corax_block():
    text = "Данные CORAX\n" + ("a" * 5000) + "\n\nЗагруженные документы:\nфайл\n\nВопрос: q"
    out = shrink_user_content(text)
    assert "aaaa" not in out or len(out) < len(text) // 2


def test_shrink_user_content_keeps_question_and_tool_header():
    wiki = "### tool:search_wiki\n" + ("w" * 4000)
    pcs = "### tool:search_computers\nПод фильтр попало: 500. Показано: 15.\n" + "\n".join(
        f"- PC-{i} os=Windows 10 ram=8" for i in range(80)
    )
    text = f"Факты.\n\nКонтекст:\n{pcs}\n\n{wiki}\n\nВопрос: какие ПК на Win10?\n\nОтвет:"
    out = shrink_user_content(text, keep_ratio=0.35)
    assert "Вопрос: какие ПК на Win10?" in out
    assert "### tool:search_computers" in out
    assert "Под фильтр попало" in out
    assert len(out) < len(text)
