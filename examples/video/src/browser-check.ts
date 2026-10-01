import { check } from '../../../packages/video/tests/browser/check.js';
const output = document.querySelector<HTMLPreElement>('#result')!;
const button = document.querySelector<HTMLButtonElement>('#run')!;
async function run() {
  button.disabled = true;
  output.textContent = 'Running real codec, composition, cancellation and scaling checks...';
  try {
    const report = await check();
    output.textContent = JSON.stringify(report, null, 2);
    document.body.dataset.result = 'passed';
    return report;
  } catch (error) {
    output.textContent = String(error);
    document.body.dataset.result = 'failed';
    console.error(error);
    throw error;
  } finally {
    button.disabled = false;
  }
}
button.onclick = () => void run().catch(() => {});
Object.assign(window, { videoCheck: { run } });
