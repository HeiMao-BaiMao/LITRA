//! Only strips the Tauri command annotation for the headless source harness.
extern crate proc_macro;
use proc_macro::TokenStream;
#[proc_macro_attribute]
pub fn command(_: TokenStream, item: TokenStream) -> TokenStream {
    item
}
