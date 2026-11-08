// Run with: node --test scripts/lib/finance-evidence-import.test.mjs
// A tiny workbook is built here from invented parts (the pictures are 1x1 images with different bytes). No real name, number or
// picture belongs in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { strToU8, zipSync, unzipSync } from 'fflate';
import { accountCandidates, evidenceId, planEvidence, readPictures } from './finance-evidence-import.mjs';

const png = (n) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n, n, n]);
const jpg = (n) => Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, n, n, n, n]);
const anchor = (kind, row, col, rid) =>
  `<xdr:${kind}><xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>${kind === 'twoCellAnchor' ? '<xdr:to><xdr:col>9</xdr:col><xdr:row>9</xdr:row></xdr:to>' : '<xdr:ext cx="1" cy="1"/>'}<xdr:pic><xdr:blipFill><a:blip r:embed="${rid}"/></xdr:blipFill></xdr:pic></xdr:${kind}>`;
function workbook(pictures) {
  return unzipSync(
    zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Other" sheetId="1" r:id="rId1"/><sheet name="Transfers" sheetId="2" r:id="rId2"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="x"/><Relationship Target="worksheets/sheet2.xml" Id="rId2" Type="x"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet/>'),
      'xl/worksheets/sheet2.xml': strToU8('<worksheet/>'),
      'xl/worksheets/_rels/sheet2.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Type="x" Target="../comments1.xml"/><Relationship Id="rId2" Type="x" Target="../drawings/drawing7.xml"/></Relationships>'),
      'xl/drawings/drawing7.xml': strToU8(`<xdr:wsDr>${pictures.map((p, i) => anchor(p.kind ?? 'oneCellAnchor', p.row - 1, p.col ?? 8, `rId${i + 1}`)).join('')}</xdr:wsDr>`),
      'xl/drawings/_rels/drawing7.xml.rels': strToU8(`<Relationships>${pictures.map((p, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="../media/image${i + 1}.${p.ext ?? 'png'}"/>`).join('')}</Relationships>`),
      ...Object.fromEntries(pictures.map((p, i) => [`xl/media/image${i + 1}.${p.ext ?? 'png'}`, p.bytes])),
    }),
  );
}

test('pictures are read from the named sheet, with the row and column they are anchored on, whatever the anchor kind', () => {
  const files = workbook([
    { row: 3, bytes: png(1) },
    { row: 5, col: 7, bytes: jpg(2), ext: 'jpg', kind: 'twoCellAnchor' },
    { row: 3, bytes: png(3) },
  ]);
  const pics = readPictures(files, 'Transfers');
  assert.deepEqual(pics.map((p) => [p.row, p.col]), [[3, 8], [5, 7], [3, 8]]);
  assert.deepEqual([...pics[1].bytes], [...jpg(2)]);
  assert.deepEqual(readPictures(files, 'Other'), [], 'a sheet without a drawing has none');
  assert.equal(readPictures(files, 'No such sheet'), null);
});

test('a picture id comes from its content, so the same screenshot is the same object every time', () => {
  assert.equal(evidenceId(png(1)), evidenceId(Uint8Array.from(png(1))));
  assert.notEqual(evidenceId(png(1)), evidenceId(png(2)));
  assert.match(evidenceId(png(1)), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('an old 8-digit account is also tried with the leading zero the payee import gives it; junk is not an account', () => {
  assert.deepEqual(accountCandidates('100000000001'), ['100000000001']);
  assert.deepEqual(accountCandidates('12345678'), ['12345678', '012345678']);
  assert.deepEqual(accountCandidates('160716'), []);
  assert.deepEqual(accountCandidates(''), []);
});

test('each picture goes to the one saved account its row names; everything else is counted, nothing is guessed', () => {
  const records = [
    { line: 2, account: '100000000001' },
    { line: 3, account: '100000000002' },
    { line: 4, account: '100000000003' },
    { line: 5, account: '12345678' },
    { line: 6, account: '160716' },
    { line: 7, account: '100000000004' },
  ];
  const accounts = new Map([['100000000001', ['a1']], ['100000000002', ['a2', 'a3']], ['012345678', ['a5']], ['100000000004', ['a4']]]);
  const pictures = [
    { row: 2, col: 8, bytes: png(1) }, // the account
    { row: 2, col: 8, bytes: png(2) }, // a second picture on the same row
    { row: 3, col: 8, bytes: png(3) }, // two saved accounts share the number
    { row: 4, col: 8, bytes: png(4) }, // no saved account
    { row: 5, col: 8, bytes: png(5) }, // matched with the leading zero
    { row: 6, col: 8, bytes: png(6) }, // not a usable account number
    { row: 1, col: 8, bytes: png(7) }, // not on a transfer row
    { row: 7, col: 8, bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) }, // not an image
    { row: 7, col: 8, bytes: png(1) }, // the same screenshot again (already used above)
    { row: 7, col: 8, bytes: png(8) }, // already stored by an earlier run
  ];
  const { items, skipped } = planEvidence({ records, pictures, byFingerprint: (n) => accounts.get(n) ?? [], existingIds: new Set([evidenceId(png(8))]) });
  assert.deepEqual(items.map((i) => [i.line, i.accountId, i.mime]), [[2, 'a1', 'image/png'], [2, 'a1', 'image/png'], [5, 'a5', 'image/png']]);
  assert.deepEqual(skipped, { notOnATransferRow: 1, notAnImage: 1, noUsableAccountNumber: 1, noSavedAccount: 1, ambiguousAccount: 1, alreadyStored: 1, sameImageAgain: 1 });
  assert.equal(new Set(items.map((i) => i.id)).size, items.length, 'one id per distinct picture');
});

test('pictures come out in sheet order, and a row with several keeps them all', () => {
  const records = [{ line: 2, account: '100000000001' }, { line: 9, account: '100000000001' }];
  const { items } = planEvidence({ records, pictures: [{ row: 9, col: 8, bytes: png(1) }, { row: 2, col: 8, bytes: png(2) }, { row: 2, col: 10, bytes: png(3) }], byFingerprint: () => ['a1'] });
  assert.deepEqual(items.map((i) => i.line), [2, 2, 9]);
});
