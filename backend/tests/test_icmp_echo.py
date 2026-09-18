from app.printer_poll import icmp_echo_ok


def test_windows_echo_reply_counts_as_alive():
    assert icmp_echo_ok(b"Reply from 10.0.0.10: bytes=32 time=1ms TTL=128")
    assert icmp_echo_ok("Ответ от 10.0.0.10: число байт=32 время=1мс TTL=64".encode("cp866"))


def test_linux_echo_reply_counts_as_alive():
    assert icmp_echo_ok(b"64 bytes from 10.0.0.10: icmp_seq=1 ttl=64 time=0.3 ms")


def test_gateway_unreachable_is_not_alive():
    assert not icmp_echo_ok(b"Reply from 10.0.0.1: Destination host unreachable.")
    assert not icmp_echo_ok("Ответ от 10.0.0.1: Заданный узел недоступен.".encode("cp866"))
    assert not icmp_echo_ok(b"Request timed out.")
    assert not icmp_echo_ok("Превышен интервал ожидания для запроса.".encode("cp866"))
    assert not icmp_echo_ok(b"")
    assert not icmp_echo_ok(None)
