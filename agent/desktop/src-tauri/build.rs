fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "windows" {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("icons/icon.ico");
        res.set("FileDescription", "CORAX Inventory Agent");
        res.set("ProductName", "CORAX Agent");
        res.set("OriginalFilename", "CORAX-Agent.exe");
        if let Err(e) = res.compile() {
            println!("cargo:warning=winresource: {e}");
        }
    }
}
