// Sin consola de Windows en la versión instalada.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    millhiore_desktop_lib::run()
}
