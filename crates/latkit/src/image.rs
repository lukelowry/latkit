//! Images: RGBA texels, what an icon marker draws and what a shot reads its picture back as, written
//! to and read from PNG.

use std::io::Cursor;
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
        if rgba.len() as u64 != u64::from(size[0]) * u64::from(size[1]) * 4 {
            return Err(Error::invalid(format!(
                "an image of {}×{} texels holds {} bytes, not {}",
                size[0],
                size[1],
                u64::from(size[0]) * u64::from(size[1]) * 4,
                rgba.len()
            )));
        }
        Ok(Image { size, rgba })
    }

    /// The image as a PNG file: eight bits a channel, alpha kept, tagged sRGB, deflated fast, since
    /// a picture is written far more often than it is stored long.
    pub fn png(&self) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, self.size[0], self.size[1]);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_source_srgb(png::SrgbRenderingIntent::Perceptual);
        encoder.set_compression(png::Compression::Fast);
        // Writing to memory fails only on a size PNG cannot hold, which an image never has.
        let mut writer = encoder.write_header().expect("a PNG header");
        writer.write_image_data(&self.rgba).expect("PNG image data");
        writer.finish().expect("a PNG end");
        out
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
    }
}
