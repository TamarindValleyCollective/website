// The progress bar both screens draw for an offer: a row of dots joined by a line, the stage reached filled in and
// named in bold, the ones before it ticked, the ones after it hollow. The stages and the rule that picks one are in
// rental-stages.mjs. Styles: .stepper in src/styles/portal-look.css (shared by the member and the admin shells).
import { STAGES } from './rental-stages.mjs';

export function rentalStepper(index) {
  const ol = document.createElement('ol');
  ol.className = 'stepper';
  ol.setAttribute('aria-label', 'Where this stands');
  STAGES.forEach((stage, i) => {
    const li = document.createElement('li');
    li.dataset.state = i < index ? 'done' : i === index ? 'current' : 'todo';
    if (i === index) li.setAttribute('aria-current', 'step');
    const dot = document.createElement('span');
    dot.className = 'stepper-dot';
    dot.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'stepper-label';
    label.textContent = stage.label;
    li.append(dot, label);
    ol.append(li);
  });
  return ol;
}
