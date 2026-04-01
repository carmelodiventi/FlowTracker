fn main() {
    // Embed MONGODB_URI at compile time so release .app bundles don't need a .env file.
    if let Ok(contents) = std::fs::read_to_string(".env") {
        for line in contents.lines() {
            let line = line.trim();
            if line.starts_with('#') || line.is_empty() {
                continue;
            }
            if let Some(val) = line.strip_prefix("MONGODB_URI=") {
                println!("cargo:rustc-env=MONGODB_URI={}", val);
            }
            if let Some(val) = line.strip_prefix("MONGODB_USER=") {
                println!("cargo:rustc-env=MONGODB_USER={}", val);
            }
            if let Some(val) = line.strip_prefix("MONGODB_PASSWORD=") {
                println!("cargo:rustc-env=MONGODB_PASSWORD={}", val);
            }
        }
    }
    tauri_build::build()
}
