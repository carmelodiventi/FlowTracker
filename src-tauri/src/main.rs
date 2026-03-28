// Prevents an extra console window from opening on Windows in release mode.
// DO NOT REMOVE this attribute.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    flow_tracker_lib::run();
}
