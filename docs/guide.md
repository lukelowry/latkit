---
orphan: true
---

# Guide

## [Datasets and queries](data.md)

- [Write a dataset](data.md#write-a-dataset)
- [Update rows](data.md#update-rows)
- [Record over time](time-series.md#record-over-time)
- [Fetch long histories in spans](time-series.md#fetch-long-histories-in-spans)
- [Stream](time-series.md#stream)
- [Read files](data.md#read-files)
- [Query rows](data.md#query-rows)

## [Scenes and marks](scenes.md)

- [Spaces](scenes.md#spaces)
- [Marks](scenes.md#marks)
- [Expressions](scenes.md#expressions)
- [Custom shaders](scenes.md#custom-shaders)
- [Themes, controls, and layouts](scenes.md#themes-controls-and-layouts)

## [Views and interaction](views.md)

- [Camera](views.md#camera)
- [Events](views.md#events)
- [Rows](views.md#rows)
- [Layouts into data](views.md#layouts-into-data)
- [Memory](views.md#memory)

## [Export images and video](pictures-and-video.md)

- [Video](pictures-and-video.md#video)

## [File formats](formats.md)

- [Schema](formats.md#schema)
- {ref}`JSON <json>`
- {ref}`Bytes <bytes>`

## [Deploy a web app](deploying.md)

- [Assets and workers](deploying.md#assets-and-workers)
- [Server-side builders and data](deploying.md#server-side-builders-and-data)

## [Use latkit in Rust](in-rust.md)

- [Share an existing device](in-rust.md#share-an-existing-device)

```{raw} html
<script>
  // Follow bookmarks from the original single-page guide.
  if (location.hash) {
    const aliases = { '#change-it': '#update-rows', '#read-back': '#query-rows' };
    const hash = aliases[location.hash] ?? location.hash;
    const links = document.querySelectorAll('article a.reference.internal');
    for (const link of links) {
      const page = new URL(link.href).pathname.split('/').pop();
      if (link.hash === hash || page === hash.slice(1) + '.html') {
        location.replace(link.href);
        break;
      }
    }
  }
</script>
```
