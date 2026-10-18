//! Images: RGBA texels, what an icon marker draws and what a shot reads its picture back as, written
//! to and read from PNG.

use std::io::{Cursor, Write};
use std::sync::Arc;

use crate::{Error, Result};

/// RGBA texels, straight alpha, sRGB, rows top to bottom.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Image {
    /// Width and height in texels.
    pub size: [u32; 2],
    /// `size[0] * size[1] * 4` bytes.
    pub rgba: Arc<[u8]>,
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

    /// The image as a PNG file: eight bits a channel, alpha kept, tagged sRGB, deflated fast, since
    /// a picture is written far more often than it is stored long.
    pub fn png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.write_png(&mut out).expect("valid image written to memory");
        out
    }

    /// Writes a PNG directly to a file or stream, reporting invalid dimensions and write failures.
    /// Uses the same encoding as [`png`](Self::png) without allocating a second complete file.
    pub fn write_png(&self, output: impl Write) -> Result<()> {
        Self::new(self.size, self.rgba.clone())?;
        let failed = |error: png::EncodingError| Error::Load(format!("cannot write PNG: {error}").into());
        let mut encoder = png::Encoder::new(output, self.size[0], self.size[1]);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&self.rgba).map_err(failed)?;
        writer.finish().map_err(failed)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_holds_what_it_was_given() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 11) as u8).collect();
        let image = Image::new([3, 2], rgba).expect("whole");
        let back = Image::from_png(&image.png()).expect("a PNG");
        assert_eq!(back, image);
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
        assert!(image.write_png(Broken).is_err());
    }
}
