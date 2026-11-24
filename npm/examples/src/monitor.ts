import { View, load } from 'latkit';
import stepResponse from '../../../docs/gallery/step-response.ts';
import { voltageDip, type Recording } from '../../../docs/gallery/voltage.ts';
import metadataUrl from '../../../crates/latkit-cli/examples/wecc240-fault/recording/metadata.json?url';
import voltageUrl from '../../../crates/latkit-cli/examples/wecc240-fault/recording/voltage.f32?url';

async function recording(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (HTTP ${response.status}).`);
  return response;
}

async function busVoltage() {
  const [metadata, bytes] = await Promise.all([
    recording(metadataUrl).then((res) => res.json() as Promise<Recording>),
    recording(voltageUrl).then((res) => res.arrayBuffer()),
  ]);
  return voltageDip(metadata, new DataView(bytes));
}

const canvas = document.querySelector('canvas')!;
try {
  await load();
  const response = new URLSearchParams(location.search).get('plot') === 'response';
  const picture = response ? stepResponse() : await busVoltage();
  document.title = response ? 'Setpoint and response' : 'John Day bus voltage';
  canvas.setAttribute('aria-label', document.title);
  await View.create(canvas, picture.scene, { camera: picture.camera });
} catch (error) {
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = `Could not draw the monitor. ${String(error)}`;
  canvas.replaceWith(message);
}
