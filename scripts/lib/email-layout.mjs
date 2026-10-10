// Shared branded email shell: green header with the TVC mark, white body
// card, small footer. Lives in scripts/lib as plain .mjs so Netlify functions
// (via netlify/functions/lib/email-layout.ts, which adds the guest footer) and
// the Node GitHub Actions scripts (check-domain-expiry.mjs, which is kept off
// Netlify on purpose) render the same template.
// Colors match the site's --tvc-* tokens in src/styles/global.css, hardcoded
// here since email HTML can't reference CSS vars.

export const EMAIL_COLORS = {
  green: '#3d6e52',
  ink: '#22291f',
  muted: '#57604f',
  line: '#e2ddc9',
  cream: '#faf7ee',
  danger: '#8a2f1f',
};

/** @param {string} s */
export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** @param {number} amountPaise @param {string} currency */
export function formatAmount(amountPaise, currency) {
  const amount = amountPaise / 100;
  if (currency === 'INR') return `₹${amount.toLocaleString('en-IN')}`;
  return `${amount.toLocaleString('en-IN')} ${currency}`;
}

/**
 * Label/value row for use inside a `<table>` in an email body.
 * @param {string} label @param {string} value @param {{ bold?: boolean, last?: boolean }} [opts]
 */
export function detailRow(label, value, opts = {}) {
  const border = opts.last ? '' : `border-bottom:1px solid ${EMAIL_COLORS.line};`;
  return `<tr>
    <td style="padding:10px 0; ${border} color:${EMAIL_COLORS.muted}; font-size:13px;">${label}</td>
    <td style="padding:10px 0; ${border} text-align:right;${opts.bold ? ' font-weight:600;' : ''}">${value}</td>
  </tr>`;
}

/** @param {string} rowsHtml */
export function detailTable(rowsHtml) {
  return `<table role="presentation" width="100%" style="margin:20px 0; border-collapse:collapse;">${rowsHtml}</table>`;
}

/** @param {string} href @param {string} text */
export function emailLink(href, text) {
  return `<a href="${href}" style="color:${EMAIL_COLORS.green};">${text}</a>`;
}

/**
 * @param {string} bodyHtml inner HTML for the white card
 * @param {string} footerHtml small print under the card
 */
export function renderEmailShell(bodyHtml, footerHtml) {
  const c = EMAIL_COLORS;
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:${c.ink}; background:${c.cream}; margin:0; padding:32px 16px;">
  <table role="presentation" width="100%" style="max-width:560px; margin:0 auto; background:#fff; border:1px solid ${c.line}; border-radius:12px; overflow:hidden;">
    <tr>
      <td style="background:${c.green}; padding:20px 28px;">
        <img src="https://tvc.farm/images/brand/tvc-logo-mark.png" width="32" height="32" alt="" style="vertical-align:middle; border-radius:50%; margin-right:10px;" />
        <span style="color:#fff; font-weight:700; font-size:1.1rem; vertical-align:middle;">Tamarind Valley Collective</span>
      </td>
    </tr>
    <tr>
      <td style="padding:28px;">
${bodyHtml}
      </td>
    </tr>
    <tr>
      <td style="padding:16px 28px; background:${c.cream}; border-top:1px solid ${c.line}; font-size:11px; color:${c.muted};">
        ${footerHtml}
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Shell for internal emails to the TVC team (alerts, digests). @param {string} bodyHtml */
export function renderStaffEmail(bodyHtml) {
  return renderEmailShell(bodyHtml, 'Internal message from the TVC website, sent to the team, not to guests.');
}
