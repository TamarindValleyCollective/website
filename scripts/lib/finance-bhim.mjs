// Step 1 of the BHIM UPI import: turn the text of a BHIM "Transaction History" PDF into plain normalised lines.
// No database and no PDF library here: the caller extracts the text (unpdf gives one text line per transaction) and
// hands it in, so this is testable with plain strings. Layout read from a real export, one row per line:
//   DD/MM/YYYY HH:MM:SS <bank name> <account> <sender>(<name>) <receiver>(<name>) <12-digit ref> PAY|COLLECT <amount> DR|CR <status>
// A payment made from the account in the BHIM app names the bank and masked account ("AXIS BANK XXXX000099"); one made
// through UPI Circle names neither ("N/A N/A") and is marked CR. Every PAY row is money leaving the company (the bank
// statement shows each as a debit), so DR/CR is NOT the direction of the money: it is read as the kind of payment.
//
// A row that cannot be read goes in `failed` with its line number; it is never dropped silently. A row whose status is
// not SUCCESS moved no money: it is counted in `unsuccessful`, not stored.
import { parseDateCell, parsePaise } from './finance-cells.mjs';

export const BHIM_FORMAT = 'bhim-upi-v1';

const ROW = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})\s+(.+?)\s+(\d{12})\s+(PAY|COLLECT)\s+([\d,]+\.\d{2})\s+(DR|CR)\s+([A-Za-z]+)\s*$/;
const PARTIES = /^(.*?)\s+(\S+\([^)]*\))\s+(\S+\([^)]*\))$/;
const BANK_AND_ACCOUNT = /^(.*?)\s+(N\/A|[Xx*]+\d+)$/;

// "xxxxx57411@ybl(xxxxxxxx H S)" -> { id, name }
const party = (s) => {
  const m = /^(\S+?)\((.*)\)$/.exec(s);
  return { id: m ? m[1] : s, name: m && m[2].trim() ? m[2].trim() : null };
};

export function isBhimText(text) {
  return /Transaction History/i.test(text) && /Payment ID\/Reference Number/i.test(text) && /DR\/CR/i.test(text);
}

export function parseBhimStatement(text) {
  if (!isBhimText(text)) throw new Error('This does not look like a BHIM transaction history: it needs the Transaction History heading and the Payment ID/Reference Number column.');
  const period = /Transaction History from (\d{2}\/\d{2}\/\d{4}) to (\d{2}\/\d{2}\/\d{4})/i.exec(text);
  const lines = [];
  const failed = [];
  const unsuccessful = { count: 0, totalPaise: 0 };
  String(text).split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!/^\d{2}\/\d{2}\/\d{4}\s/.test(line)) return;
    const row = i + 1;
    try {
      const m = ROW.exec(line);
      if (!m) throw new Error('the row does not have the BHIM columns');
      const [, date, time, middle, ref, kind, amount, drcr, status] = m;
      const p = PARTIES.exec(middle);
      if (!p) throw new Error('the sender and receiver could not be read');
      const b = BANK_AND_ACCOUNT.exec(p[1].trim());
      if (!b) throw new Error('the bank and account could not be read');
      const paise = parsePaise(amount);
      if (paise <= 0) throw new Error('amount is not above zero');
      if (status.toUpperCase() !== 'SUCCESS') {
        unsuccessful.count += 1;
        unsuccessful.totalPaise += paise;
        return;
      }
      if (kind !== 'PAY') throw new Error('a COLLECT request; this import only reads payments made');
      const bankName = b[1].trim();
      const account = b[2];
      lines.push({
        row,
        paidAt: parseDateCell(date),
        time,
        sender: party(p[2]),
        receiver: party(p[3]),
        // The last four digits of the account named on the row ("XXXX000099" -> "0099"); null when none is named.
        accountLast4: /\d{4}$/.test(account) ? account.slice(-4) : null,
        bankName: /^n\/a$/i.test(bankName) ? null : bankName,
        drcr,
        upiRef: ref,
        amountPaise: paise,
      });
    } catch (err) {
      failed.push({ row, reason: err.message });
    }
  });
  return {
    format: BHIM_FORMAT,
    from: period ? parseDateCell(period[1]) : null,
    to: period ? parseDateCell(period[2]) : null,
    lines, failed, unsuccessful,
  };
}
