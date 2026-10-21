//! Images: RGBA texels, what an icon marker draws and what a shot reads its picture back as, written
//! as PNG, JPEG, or lossless WebP and read from PNG.

use std::io::{Cursor, Write};
use std::sync::Arc;

use crate::{Error, Result};

/// RGBA texels, straight alpha, sRGB, rows top to bottom.
#[derive(Clone, PartialEq, Eq, Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(remote = "Self", deny_unknown_fields)]
#[schemars(rename = "Bitmap")]
pub struct Image {
    /// Width and height in texels.
    pub size: [u32; 2],
    /// `size[0] * size[1] * 4` bytes.
    pub rgba: Arc<[u8]>,
}

/// An image reads as `{ size, rgba }`, four bytes a texel.
impl<'de> serde::Deserialize<'de> for Image {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Image, D::Error> {
        let Image { size, rgba } = Image::deserialize(deserializer)?;
        Image::new(size, rgba).map_err(serde::de::Error::custom)
    }
}

impl Image {
    /// An image of `size` texels holding `rgba`, four bytes a texel.
    pub fn new(size: [u32; 2], rgba: impl Into<Arc<[u8]>>) -> Result<Image> {
        let rgba = rgba.into();
        let expected = u64::from(size[0]).checked_mul(u64::from(size[1])).and_then(|pixels| pixels.checked_mul(4));
        if size.contains(&0) || expected != Some(rgba.len() as u64) {
            return Err(Error::invalid("an image needs positive dimensions and exactly four bytes per pixel"));
        }
        Ok(Image { size, rgba })
    }

    /// The image written as a file of `format`.
    pub fn encode(&self, format: ImageFormat) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.write(format, &mut out)?;
        Ok(out)
    }

    /// Writes the image as a file of `format` to a file or stream, reporting write failures.
    pub fn write(&self, format: ImageFormat, mut output: impl Write) -> Result<()> {
        Self::new(self.size, self.rgba.clone())?;
        let [width, height] = self.size;
        let failed = |error: &dyn std::fmt::Display| Error::Io(format!("cannot write {format}: {error}").into());
        match format {
            ImageFormat::Png => {
                let mut encoder = png::Encoder::new(output, width, height);
                encoder.set_color(png::ColorType::Rgba);
                encoder.set_depth(png::BitDepth::Eight);
                encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
                // A picture is written far more often than it is stored long.
                encoder.set_compression(png::Compression::Fast);
                let mut writer = encoder.write_header().map_err(|e| failed(&e))?;
                writer.write_image_data(&self.rgba).map_err(|e| failed(&e))?;
                writer.finish().map_err(|e| failed(&e))
            }
            ImageFormat::Jpeg { quality } => {
                if !(1..=100).contains(&quality) {
                    return Err(Error::invalid("a JPEG's quality runs from 1 to 100").at("quality"));
                }
                let side = |v: u32| u16::try_from(v).map_err(|_| failed(&"a JPEG is at most 65535 pixels a side"));
                let mut bytes = Vec::new();
                jpeg_encoder::Encoder::new(&mut bytes, quality)
                    .encode(&self.rgba, side(width)?, side(height)?, jpeg_encoder::ColorType::Rgba)
                    .map_err(|e| failed(&e))?;
                output.write_all(&bytes).map_err(|e| failed(&e))
            }
            ImageFormat::WebP => image_webp::WebPEncoder::new(output)
                .encode(&self.rgba, width, height, image_webp::ColorType::Rgba8)
                .map_err(|e| failed(&e)),
        }
    }

    /// The image a PNG file holds, any color type and depth made eight bit RGBA.
    pub fn from_png(bytes: &[u8]) -> Result<Image> {
        let failed = |e: png::DecodingError| Error::invalid(format!("not a PNG image: {e}"));
        let mut decoder = png::Decoder::new(Cursor::new(bytes));
        decoder.set_transformations(png::Transformations::normalize_to_color8());
        let mut reader = decoder.read_info().map_err(failed)?;
        let mut buffer = vec![0; reader.output_buffer_size().ok_or_else(|| Error::invalid("a PNG too large"))?];
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

/// How an image is written as a file.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum ImageFormat {
    /// PNG: lossless, alpha kept, tagged sRGB.
    #[default]
    Png,
    /// JPEG at `quality` from 1 to 100: small, its alpha dropped.
    Jpeg {
        /// From 1, smallest, to 100, sharpest; 90 is good for pictures of views.
        quality: u8,
    },
    /// WebP, lossless: smaller than PNG, alpha kept.
    WebP,
}

impl ImageFormat {
    /// The format a file's `extension` names: `png`, `jpg` or `jpeg` at quality 90, or `webp`.
    pub fn of_extension(extension: &str) -> Option<ImageFormat> {
        match extension.to_ascii_lowercase().as_str() {
            "png" => Some(ImageFormat::Png),
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg { quality: 90 }),
            "webp" => Some(ImageFormat::WebP),
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
    fn png_holds_what_it_was_given() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 11) as u8).collect();
        let image = Image::new([3, 2], rgba).expect("whole");
        let back = Image::from_png(&image.encode(ImageFormat::Png).expect("written")).expect("a PNG");
        assert_eq!(back, image);
    }

    #[test]
    fn every_format_writes_its_file() {
        let rgba: Vec<u8> = (0..16 * 8 * 4).map(|i| (i * 7) as u8).collect();
        let image = Image::new([16, 8], rgba).expect("whole");
        let jpeg = image.encode(ImageFormat::Jpeg { quality: 90 }).expect("written");
        assert_eq!(jpeg[..3], [0xff, 0xd8, 0xff], "a JPEG starts with its marker");
        let webp = image.encode(ImageFormat::WebP).expect("written");
        assert!(webp.starts_with(b"RIFF") && &webp[8..12] == b"WEBP", "a WebP is a RIFF file");
        assert_eq!(ImageFormat::of_extension("JPG"), Some(ImageFormat::Jpeg { quality: 90 }));
        assert_eq!(ImageFormat::of_extension("gif"), None);
    }

    #[test]
    fn an_image_holds_four_bytes_a_texel() {
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
