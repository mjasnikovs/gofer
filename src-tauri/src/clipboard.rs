//! The clipboard's image, which the web layer cannot see.
//!
//! Pasting an image into the composer is handled in the renderer everywhere except here. WebKitGTK
//! — the webview Tauri uses on Linux — hands a paste event an empty `clipboardData` when the
//! clipboard holds an image: no files, no items, no types. Text arrives normally, so the seam is
//! images specifically, and no amount of renderer code can reach around it.
//!
//! So the renderer asks for the image instead of reading it. `arboard` talks to the platform
//! clipboard directly, which on Wayland means the data-control protocol rather than X11.
//!
//! What comes back is PNG regardless of what was copied. `arboard` decodes whatever the clipboard
//! offered into raw pixels, and raw pixels are both far larger over the bridge and not something
//! the model accepts — a full-screen capture is 8 MiB of RGBA and about 200 KiB as PNG.

use arboard::Clipboard;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use image::{ImageEncoder, codecs::png::PngEncoder};
use serde::Serialize;

/// A PNG from the clipboard, base64 encoded, as the renderer needs it to build a `File`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    pub width: u32,
    pub height: u32,
    /// The PNG bytes, base64 encoded. The renderer decodes this into a blob.
    pub png_base64: String,
}

/// Encodes clipboard pixels as PNG. Split from the read so the encoding is testable without a
/// clipboard, which no test environment reliably has.
///
/// The frame is measured here rather than left to the encoder, which panics on a buffer that does
/// not fill it. A clipboard is an outside input, and a malformed one must not take the app down.
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<ClipboardImage, String> {
    let expected = (u64::from(width) * u64::from(height)).saturating_mul(4);
    if expected == 0 || rgba.len() as u64 != expected {
        return Err(format!(
            "a {width}×{height} image needs {expected} bytes and the clipboard gave {}",
            rgba.len()
        ));
    }
    let mut png = Vec::new();
    PngEncoder::new(&mut png)
        .write_image(rgba, width, height, image::ExtendedColorType::Rgba8)
        .map_err(|error| error.to_string())?;
    Ok(ClipboardImage {
        width,
        height,
        png_base64: STANDARD.encode(&png),
    })
}

/// The clipboard's image, or `None` when it holds something else.
///
/// An empty clipboard and a clipboard holding text are the same answer here: nothing to attach.
/// Only a clipboard that holds an image this build cannot read is a failure worth a message.
pub fn read_image() -> Result<Option<ClipboardImage>, String> {
    let mut clipboard = match Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(error) => return Err(format!("The clipboard could not be opened: {error}")),
    };
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => {
            return Ok(None);
        }
        Err(error) => return Err(format!("The clipboard image could not be read: {error}")),
    };
    let width = u32::try_from(image.width).unwrap_or(0);
    let height = u32::try_from(image.height).unwrap_or(0);
    if width == 0 || height == 0 {
        return Ok(None);
    }
    encode_png(width, height, &image.bytes)
        .map(Some)
        .map_err(|error| format!("The clipboard image could not be encoded: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_pixels_as_a_png() {
        let rgba = vec![255, 0, 0, 255, 0, 255, 0, 255];
        let image = encode_png(2, 1, &rgba).expect("the pixels encode");
        assert_eq!(image.width, 2);
        assert_eq!(image.height, 1);
        let png = STANDARD
            .decode(&image.png_base64)
            .expect("the payload is base64");
        assert_eq!(&png[1..4], b"PNG");
    }

    /// A clipboard is an outside input, and a zero-sized frame must be refused rather than encoded:
    /// the encoder panics on a buffer that does not fill its frame, and a panic here takes the app.
    #[test]
    fn refuses_a_frame_with_no_pixels_in_it() {
        assert!(encode_png(0, 8, &[]).is_err());
        assert!(encode_png(8, 0, &[]).is_err());
    }

    #[test]
    fn refuses_pixels_that_do_not_fill_the_frame() {
        assert!(encode_png(4, 4, &[0, 0, 0, 255]).is_err());
    }
}
