from app.gpu_normalize import catalog_gpu_counts, gpu_catalog_names, gpu_score, is_virtual_gpu_name, resolve_gpu_name


def test_virtual_adapters_are_rejected():
    assert is_virtual_gpu_name("Parsec Virtual Display Adapter")
    assert is_virtual_gpu_name("TeamViewer Adapter")
    assert is_virtual_gpu_name("OrayIddDriver Device")
    assert is_virtual_gpu_name("Microsoft Remote Display Adapter")
    assert is_virtual_gpu_name("USB Mobile Monitor Virtual Display")
    assert not is_virtual_gpu_name("NVIDIA GeForce RTX 3060")
    assert not is_virtual_gpu_name("Intel(R) UHD Graphics 730")
    assert not is_virtual_gpu_name("VMware SVGA 3D")


def test_resolve_picks_real_card_when_virtual_is_first():
    name = resolve_gpu_name(
        "Parsec Virtual Display Adapter",
        {
            "gpus": [
                {"name": "Parsec Virtual Display Adapter", "driver_version": "10.0.1.2", "vram_gb": None},
                {"name": "NVIDIA GeForce RTX 3060", "driver_version": "32.0.15.6094", "vram_gb": 12},
                {"name": "Intel(R) UHD Graphics 730", "vram_gb": 0.13},
            ]
        },
    )
    assert name == "NVIDIA GeForce RTX 3060 / Intel(R) UHD Graphics 730"


def test_resolve_uses_video_processor_when_name_is_a_driver():
    name = resolve_gpu_name(
        None,
        {
            "gpus": [
                {
                    "name": "OrayIddDriver Device",
                    "video_processor": "AMD Radeon RX 6600",
                    "driver_version": "1.0.0.0",
                }
            ]
        },
    )
    assert name == "AMD Radeon RX 6600"


def test_resolve_drops_software_driver_when_that_is_all_wmi_sent():
    assert resolve_gpu_name("AnyDesk Video Driver", {"gpus": [{"name": "AnyDesk Video Driver"}]}) is None


def test_discrete_outscores_igp():
    assert gpu_score("NVIDIA GeForce GTX 1660", 6) > gpu_score("Intel(R) UHD Graphics 630", 0.1)


def test_catalog_splits_two_cards_and_drops_virtual():
    assert gpu_catalog_names("NVIDIA GeForce RTX 3060 / Intel(R) UHD Graphics 730") == [
        "NVIDIA GeForce RTX 3060",
        "Intel(R) UHD Graphics 730",
    ]
    assert gpu_catalog_names("Microsoft Remote Display Adapter") == []
    counts = catalog_gpu_counts(
        [
            "NVIDIA GeForce RTX 3060 / Intel(R) UHD Graphics 730",
            "NVIDIA GeForce RTX 3060",
            "Parsec Virtual Display Adapter",
            None,
        ]
    )
    assert counts[0] == ("NVIDIA GeForce RTX 3060", 2)
    assert ("Intel(R) UHD Graphics 730", 1) in counts
