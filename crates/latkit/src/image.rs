//! RGBA images: icon marker textures and the pictures shots read back. Images encode to PNG, JPEG,
//! or lossless WebP, and decode from PNG.

use std::io::{Cursor, Write};
use std::sync::Arc;

use crate::{Error, Result};

/// An image of RGBA texels: straight alpha, sRGB, rows top to bottom.
#[derive(Clone, PartialEq, Eq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(remote = "Self", deny_unknown_fields)]
#[schemars(rename = "Bitmap")]
pub struct Image {
    /// Width and height in texels.
    pub size: [u32; 2],
    /// `size[0] * size[1] * 4` bytes.
    pub rgba: Arc<[u8]>,
}

/// Deserializes from `{ size, rgba }`, four bytes per texel, and checks the length.
impl<'de> serde::Deserialize<'de> for Image {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Image, D::Error> {
        let Image { size, rgba } = Image::deserialize(deserializer)?;
        Image::new(size, rgba).map_err(serde::de::Error::custom)
    }
}

impl Image {
    /// An image of `size` texels from `rgba`, four bytes per texel. Fails if a dimension is zero
    /// or `rgba` has the wrong length.
    pub fn new(size: [u32; 2], rgba: impl Into<Arc<[u8]>>) -> Result<Image> {
        let rgba = rgba.into();
        let expected = u64::from(size[0]).checked_mul(u64::from(size[1])).and_then(|pixels| pixels.checked_mul(4));
        if size.contains(&0) || expected != Some(rgba.len() as u64) {
            return Err(Error::invalid("an image needs positive dimensions and exactly four bytes per pixel"));
        }
        Ok(Image { size, rgba })
    }

    /// Whether every texel is opaque. The browser host asks before it encodes.
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn opaque(&self) -> bool {
        self.rgba.as_chunks::<4>().0.iter().all(|texel| texel[3] == u8::MAX)
    }

    /// Encodes the image as a `format` file.
    pub fn encode(&self, format: ImageFormat) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.write(format, &mut out)?;
        Ok(out)
    }

    /// Writes the image as a `format` file to a file or stream. Write failures return
    /// [`Error::Io`].
    pub fn write(&self, format: ImageFormat, output: impl Write) -> Result<()> {
        match format {
            ImageFormat::Png => self.write_png(output),
            ImageFormat::Jpeg { quality } => self.write_jpeg(quality, output),
            ImageFormat::WebP => self.write_webp(output),
        }
    }

    /// Writes the image as a PNG file. Each format has a writer of its own, so a caller that
    /// writes one links only that format's encoder.
    pub(crate) fn write_png(&self, output: impl Write) -> Result<()> {
        Self::new(self.size, self.rgba.clone())?;
        let failed = |error: png::EncodingError| unwritten(ImageFormat::Png, &error);
        let mut encoder = png::Encoder::new(output, self.size[0], self.size[1]);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        // Favor speed over size: pictures are written often and rarely stored long.
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&self.rgba).map_err(failed)?;
        writer.finish().map_err(failed)
    }

    /// Writes the image as a JPEG file at `quality` 1 to 100.
    fn write_jpeg(&self, quality: u8, mut output: impl Write) -> Result<()> {
        Self::new(self.size, self.rgba.clone())?;
        if !(1..=100).contains(&quality) {
            return Err(Error::invalid("JPEG quality must be from 1 to 100").at("quality"));
        }
        let format = ImageFormat::Jpeg { quality };
        let side = |v: u32| u16::try_from(v).map_err(|_| unwritten(format, &"each side must be at most 65535 pixels"));
        let mut bytes = Vec::new();
        jpeg_encoder::Encoder::new(&mut bytes, quality)
            .encode(&self.rgba, side(self.size[0])?, side(self.size[1])?, jpeg_encoder::ColorType::Rgba)
            .map_err(|e| unwritten(format, &e))?;
        output.write_all(&bytes).map_err(|e| unwritten(format, &e))
    }

    /// Writes the image as a lossless WebP file.
    pub(crate) fn write_webp(&self, output: impl Write) -> Result<()> {
        Self::new(self.size, self.rgba.clone())?;
        image_webp::WebPEncoder::new(output)
            .encode(&self.rgba, self.size[0], self.size[1], image_webp::ColorType::Rgba8)
            .map_err(|e| unwritten(ImageFormat::WebP, &e))
    }

    /// Decodes a PNG file. Any color type and bit depth converts to 8-bit RGBA.
    pub fn from_png(bytes: &[u8]) -> Result<Image> {
        let failed = |e: png::DecodingError| Error::invalid(format!("not a PNG image: {e}"));
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(failed)?;
        let mut buffer = vec![0; reader.output_buffer_size().ok_or_else(|| Error::invalid("PNG too large to decode"))?];
        let info = reader.next_frame(&mut buffer).map_err(failed)?;
        let texels = (info.width * info.height) as usize;
        let rgba: Vec<u8> = match info.color_type {
            png::ColorType::Rgba => buffer[..texels * 4].to_vec(),
            png::ColorType::Rgb => {
                buffer[..texels * 3].as_chunks::<3>().0.iter().flat_map(|c| [c[0], c[1], c[2], 255]).collect()
            }
            png::ColorType::GrayscaleAlpha => {
                buffer[..texels * 2].as_chunks::<2>().0.iter().flat_map(|c| [c[0], c[0], c[0], c[1]]).collect()
            }
            png::ColorType::Grayscale => buffer[..texels].iter().flat_map(|&g| [g, g, g, 255]).collect(),
            png::ColorType::Indexed => return Err(Error::invalid("a PNG palette was not expanded")),
        };
        Image::new([info.width, info.height], rgba)
    }
}

/// The error for a `format` file that could not be written, and why.
fn unwritten(format: ImageFormat, error: &dyn std::fmt::Display) -> Error {
    Error::Io(format!("cannot write {format}: {error}").into())
}

/// An image file format.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ImageFormat {
    /// PNG: lossless, keeps alpha, tagged sRGB.
    #[default]
    Png,
    /// JPEG at `quality` 1 to 100: small files, alpha dropped.
    Jpeg {
        /// 1 (smallest) to 100 (sharpest). 90 suits pictures of views.
        quality: u8,
    },
    /// Lossless WebP: smaller than PNG, keeps alpha.
    WebP,
}

impl ImageFormat {
    /// The format for a file `extension`, ignoring case: `png`, `jpg` or `jpeg` (quality 90), or
    /// `webp`.
    pub fn of_extension(extension: &str) -> Option<ImageFormat> {
        match extension.to_ascii_lowercase().as_str() {
            "png" => Some(ImageFormat::Png),
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg { quality: 90 }),
            "webp" => Some(ImageFormat::WebP),
            _ => None,
        }
    }

    /// The code an encoding job writes the format as: 0 for PNG, 1 for WebP, and `0x100` plus the
    /// quality for JPEG.
    #[cfg(any(test, target_arch = "wasm32"))]
    pub(crate) fn code(self) -> u32 {
        match self {
            ImageFormat::Png => 0,
            ImageFormat::WebP => 1,
            ImageFormat::Jpeg { quality } => 0x100 | u32::from(quality),
        }
    }

    /// The format written as `code`.
    pub(crate) fn from_code(code: u32) -> Option<ImageFormat> {
        match code {
            0 => Some(ImageFormat::Png),
            1 => Some(ImageFormat::WebP),
            0x100..=0x1ff => Some(ImageFormat::Jpeg { quality: (code & 0xff) as u8 }),
            _ => None,
        }
    }
}

impl std::fmt::Display for ImageFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ImageFormat::Png => "PNG",
            ImageFormat::Jpeg { .. } => "JPEG",
            ImageFormat::WebP => "WebP",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_round_trips_losslessly() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 11) as u8).collect();
        let image = Image::new([3, 2], rgba).expect("a valid image");
        let back = Image::from_png(&image.encode(ImageFormat::Png).expect("written")).expect("a PNG");
        assert_eq!(back, image);
    }

    #[test]
    fn every_format_writes_its_file() {
        let rgba: Vec<u8> = (0..16 * 8 * 4).map(|i| (i * 7) as u8).collect();
        let image = Image::new([16, 8], rgba).expect("a valid image");
        let jpeg = image.encode(ImageFormat::Jpeg { quality: 90 }).expect("written");
        assert_eq!(jpeg[..3], [0xff, 0xd8, 0xff], "a JPEG starts with its marker");
        let webp = image.encode(ImageFormat::WebP).expect("written");
        assert!(webp.starts_with(b"RIFF") && &webp[8..12] == b"WEBP", "a WebP is a RIFF file");
        assert_eq!(ImageFormat::of_extension("JPG"), Some(ImageFormat::Jpeg { quality: 90 }));
        assert_eq!(ImageFormat::of_extension("gif"), None);
    }

    #[test]
    fn images_need_a_positive_size_and_four_bytes_per_texel() {
        assert!(Image::new([2, 2], vec![0; 15]).is_err());
        assert!(Image::from_png(b"not a png").is_err());
        assert!(Image::new([0, 0], Vec::new()).is_err());
        assert!(Image::new([u32::MAX, u32::MAX], Vec::new()).is_err());
    }

    #[test]
    fn writing_reports_stream_failures() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let image = Image::new([1, 1], vec![0; 4]).unwrap();
        assert!(image.write(ImageFormat::Png, Broken).is_err());
    }
}
