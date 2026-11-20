// Which bank an IFSC code is from, read off its first four letters. A typing aid for the person entering bank details (a wrong or unknown
// prefix is a prompt to look again), not a check: it says nothing about the branch or whether the account exists. Only codes that are
// well established are listed; anything else gives null rather than a guess.
const BANKS = {
  SBIN: 'State Bank of India',
  HDFC: 'HDFC Bank',
  ICIC: 'ICICI Bank',
  UTIB: 'Axis Bank',
  KKBK: 'Kotak Mahindra Bank',
  PUNB: 'Punjab National Bank',
  BARB: 'Bank of Baroda',
  CNRB: 'Canara Bank',
  IDIB: 'Indian Bank',
  UBIN: 'Union Bank of India',
  BKID: 'Bank of India',
  IOBA: 'Indian Overseas Bank',
  YESB: 'Yes Bank',
  INDB: 'IndusInd Bank',
  IDFB: 'IDFC First Bank',
  FDRL: 'Federal Bank',
  KARB: 'Karnataka Bank',
  KVBL: 'Karur Vysya Bank',
  CBIN: 'Central Bank of India',
  MAHB: 'Bank of Maharashtra',
  UCBA: 'UCO Bank',
  SIBL: 'South Indian Bank',
  CIUB: 'City Union Bank',
  TMBL: 'Tamilnad Mercantile Bank',
  RATN: 'RBL Bank',
  AUBL: 'AU Small Finance Bank',
};

/** @param {unknown} ifsc @returns {string | null} */
export function bankNameOfIfsc(ifsc) {
  if (typeof ifsc !== 'string' || ifsc.trim().length < 4) return null;
  return /** @type {Record<string, string>} */ (BANKS)[ifsc.trim().slice(0, 4).toUpperCase()] ?? null;
}
