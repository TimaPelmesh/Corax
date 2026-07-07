from app.wikirag_context_budget import (
    estimate_messages_tokens,
    estimate_tokens,
    human_lm_studio_error,
    is_context_overflow_error,
    prompt_token_budget,
    shrink_messages,
    shrink_user_content,
)


def test_estimate_tokens_positive():
    assert estimate_tokens("abc") >= 1


def test_context_overflow_detection():
    err = "request (5451 tokens) exceeds the available context size (4096 tokens)"
    assert is_context_overflow_error(err)
    msg = human_lm_studio_error(400, err)
    assert "4096" in msg or "контекст" in msg.lower()


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
