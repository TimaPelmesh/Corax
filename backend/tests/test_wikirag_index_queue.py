from app.wikirag_index_queue import WikiRagIndexQueue


def test_enqueue_dedup_before_start():
    q = WikiRagIndexQueue()
    assert q.enqueue(1, 1, 2) == 2
    assert q.enqueue(2, 3) == 1
    assert q.queue_size == 3
    assert q.indexing
    assert q.enqueue(-1, 0) == 0
