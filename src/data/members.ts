// The Tamarind Valley Collective member directory shown on
// src/components/views/MembersView.astro. Lives in its own module (rather
// than inline in that .astro file's frontmatter) so SiteSearch.astro can
// also import it at build time for its member-name lookup (see
// searchMembers() there) - Pagefind's own full-text index doesn't reliably
// deep-link to one specific card out of ~130 near-identical ones on a
// single page (its chunking merges many cards together, so a search hit's
// title/anchor can land on the wrong member entirely - see the
// member-name-lookup changelog entry), so member-name matches need this
// separate, always-correct path instead.
//
// Sourced from the community's earlier syntropic.in/member directory; Madhav & Krithika
// omitted here since they're already listed under Staff.
//
// DELIBERATE TRANSLATION SCOPE DECISION: these 53 bios are left in English
// across all locales (kn/ta included), while every other string on the
// Members page is translated. Almost every bio is a one-line namedrop of an
// employer/job-title ("Works for VMware", "Program manager at Amazon") or
// is empty (~20 of the 53) - proper nouns (company names) dominate what
// little text there is, so translating them would mostly be transliterating
// brand names rather than conveying new meaning, for 53 short strings of
// low individual value. Flagged as a candidate for follow-up if a native
// reviewer wants them translated later.
export interface Member {
  name: string;
  bio: string;
  photo: string | null;
  // Separate family members can each submit their own photo for a shared
  // card (e.g. Sharath and Deepa each uploading their own picture rather
  // than one joint one) - when that happens this holds all of them and the
  // card shows a stacked cluster instead of picking just one. Optional and
  // additive so the ~53 existing single-photo entries above don't need to
  // change; falls back to `photo` when absent.
  photos?: string[];
  // Uncropped counterpart to `photo` (capped at 1600px, not square-cropped
  // to fit the round avatar) - the popup's click-to-enlarge lightbox uses
  // this when present, since the square crop alone can lose people/context
  // from a group photo (e.g. Om & Pavithra's card, caught 2026-08-12: the
  // only asset on hand was the already-cropped avatar, so "enlarge" just
  // blew that up instead of showing the actual photo). No full version
  // exists for the ~53 legacy photos or any card processed before this, so
  // the lightbox falls back to `photo`/`photos` when absent. See
  // fetch-member-photo.mjs, which writes both from one source image.
  photoFull?: string;
  photosFull?: string[];
  // A hand-written one-liner for the card front. The original 53 bios were
  // already written to be card-length, so they need no summary of their
  // own - this only exists for form-sourced bios, which are longer,
  // first-person "what do you do today" answers that read poorly when
  // blindly character-truncated mid-sentence. See summaryFor() in
  // MembersView.astro.
  summary?: string;
  family?: string;
  // Children/pets named in `family` (e.g. ['Deesha', 'Aryaan', 'Thalia']) -
  // highlighted inline like the card's own people, but never linked (no
  // social profile is ever collected for them). Kept separate from the
  // card's own name(s) since only those pair up with `social` by position.
  familyNames?: string[];
  // A single string renders as one unattributed quote (e.g. a couple's
  // shared "we" sentiment, or just one person's answer). When both partners
  // on a card submit their own separate why-TVC answer, use an array
  // instead - one quote bubble per entry, each captioned with the matching
  // name once there's more than one (paired by position with the card's own
  // name split, same convention as `social` below) rather than silently
  // merging two people's words into one paraphrased quote.
  whyTVC?: string | string[];
  // The form asks for "LinkedIn or another social profile", so this can be
  // any platform - rendered by detecting the host below, not assumed to be
  // LinkedIn. A card can also carry more than one (e.g. a couple's card
  // listing each partner's own profile), hence a list rather than one URL.
  social?: string[];
}

export const members: Member[] = [
  { name: 'Abhinav & Divya', bio: 'Abhinav works for VMware. Divya is an engineer, now teaching baking as well as taking orders from home.', photo: '/images/members/abhinav-and-divya.jpg' },
  { name: 'Akash & Toshal', bio: 'Akash runs his startup Instamojo. Toshal is a software professional.', photo: '/images/members/akash-gehani.jpg' },
  { name: 'Amit Gupta', bio: '', photo: null },
  { name: 'Amit & Jayashree', bio: '', photo: null },
  { name: 'Anand & Devi', bio: '', photo: null },
  { name: 'Om & Pavithra', summary: 'Om works on technology, language, and culture preservation; Pavithra heads Security Research at Indusface.', bio: "Om works at the intersection of technology, language, culture, and knowledge preservation through Servants of Knowledge, Sanchaya, and Sanchi Foundation. Pavithra is Head of Security Research at Indusface, a cybersecurity startup, while lending immense support to all of Om's adventures along with the little one.", photo: '/images/members/om-and-pavithra.jpg', photoFull: '/images/members/om-and-pavithra-full.jpg', family: "Om, Pavithra, and their 10-year-old Omisha are the three musketeers. Omisha keeps them on their toes with her endless curiosity and love for art, books, adventure, nature, music, gymnastics, and Bharatanatyam.", familyNames: ['Omisha'], whyTVC: 'We wanted to be part of a community where living, learning, sharing, and building something meaningful together are part of everyday life.', social: ['https://www.linkedin.com/in/omshivaprakash', 'https://www.linkedin.com/in/pavithrah'] },
  { name: 'Ananth & Manasa', bio: 'Ananth is a program manager with Amazon. Manasa is a marketing manager with Citrix, with interests in traveling, fitness among other things.', photo: '/images/members/ananth-and-manasa.jpg' },
  { name: 'Roopa PN', bio: '', photo: null },
  { name: 'Ankur & Kavitha', bio: 'Ankur and Kavitha are faculty at IIM Ahmedabad in Public Policy and Computer Science respectively.', photo: '/images/members/ankur-and-kavitha.jpg' },
  { name: 'Anu & Balu', bio: 'Balu is a techie, works with McAfee. Anu is in the education space, cofounded Tide Learning, which works in the early childhood and primary education area.', photo: '/images/members/anu-and-balu.jpg' },
  { name: 'Arun & Uthara', bio: 'Arun heads the strategy division in Grameen Koota (MFI.) Uthara is discovering social change through 2 NGOs - Buzz Women and Avantika Foundation.', photo: '/images/members/arun-and-uthara.jpg' },
  { name: 'Ashirwad & Harshadha', bio: 'Ashirwad is an IT professional. Harshada is an Ayurvedic doctor by education and also a passionate cook.', photo: '/images/members/ashirwad-and-harshadha.jpg' },
  { name: 'Aunindo & Manoshi', bio: '', photo: null },
  { name: 'Sundar & Anitha', summary: 'Sundar is a Software Engineer at Indeed; Anitha is a Japanese expert at Fuso Tech Centre.', bio: 'Sundar is a Software Engineer at Indeed, who likes to deal with text. Anitha is a Japanese expert at Fuso Tech Centre in Chennai.', photo: '/images/members/sundar-and-anitha.jpg', photoFull: '/images/members/sundar-and-anitha-full.jpg', family: 'Sundar and Anitha are married with one son, Mugil (17). Sundar is into languages; Anitha enjoys listening to songs. Mugil likes watching football, Jetlag, or Physics explainers.', familyNames: ['Mugil'], whyTVC: 'We like the idea of a little home in green space, with a like-minded community, subsisting on a community farm, not too far away from wildlife, without much of a negative footprint.', social: ['https://www.linkedin.com/in/oligoglot/'] },
  { name: 'Rajavel & Vidhya', bio: 'Rajavel is now a teacher in the field of software design. Vidhya is an early childhood special educator and has interests in dance, fitness and gardening.', photo: '/images/members/rajavel-and-vidhya.jpg' },
  { name: 'Divya & Sudhir', summary: 'Divya consults on sustainable waste management and municipal reforms; Sudhir leads Digital Engineering at Thoughtworks.', bio: 'Divya is working as an independent consultant in Sustainable Waste Management, currently focussing on municipal reforms. Sudhir is with Thoughtworks for close to two decades, currently Global Head of Digital Engineering Centre.', photo: '/images/members/divya-and-sudhir.jpg', photoFull: '/images/members/divya-and-sudhir-full.jpg', family: "Divya and Sudhir have two daughters: Arukshita, pursuing her Master's in Bioinformatics at the University of Michigan, Ann Arbor, and Aarna, in class 11. As a family they enjoy late-night car rides and road trips. Sudhir and Aarna are trained yoga teachers; Arukshita is a long-distance swimmer and the most hands-on with gardening. Divya is a Sudoku buff, while Sudhir loves quizzing.", familyNames: ['Arukshita', 'Aarna'], whyTVC: 'TVC was a dream come true, we wanted to live amidst greenery and in simplicity but getting to do that with a like minded community was a big attraction.', social: ['https://www.linkedin.com/in/divya-tiwari-3019296', 'https://www.linkedin.com/in/sudhirtiwari'] },
  { name: 'Harishri Babuji', summary: 'Harishri works at Schneider Electric in the Customer Experience space.', bio: 'Harishri works at Schneider Electric in the Customer Experience space. She has traversed across Telecom, IT, and Energy industries over the span of her career.', photo: '/images/members/harishri-babuji.jpg', photoFull: '/images/members/harishri-babuji-full.jpg', family: 'Harishri joined TVC with her late husband, Elvin. She now considers the TVC family as her own extended one!', whyTVC: 'Being with like-minded people in a community with purpose', social: ['https://linkedin.com/in/harishri'] },
  { name: 'Kaushik Raghunath', bio: '', photo: null },
  { name: 'Pradeep & Ramya', bio: 'Pradeep is a chip designer by profession, also a public policy enthusiast. Ramya is a Doctor.', photo: '/images/members/k-b-pradeep.jpg' },
  { name: 'Kiran & Zainab', bio: 'Zainab and Kiran live in Kodihalli and work in Indiranagar.', photo: '/images/members/kiran-and-zainab.jpg' },
  { name: 'Ram & Krishna', summary: 'Ram previously worked at Philips Software/T P Vision; Krishna is with Azim Premji Foundation.', bio: 'Ram worked in Philips Software Centre/T P Vision, and right now is exploring other interests in life, including options for a sustainable living. Krishna is with Azim Premji Foundation. She has many other interests as well, and also hosts the podcast New Indian Woman.', photo: '/images/members/ram-and-krishna.jpg', family: 'Ram and Krishna have two children: Nithya, currently in the Civil Service (IRS), and Varun, pursuing his final year of the BS-MS course at IISER TVM with Physics as major and Bio as minor.', familyNames: ['Nithya', 'Varun'], whyTVC: 'A fascination towards mindful and sustainable living, being part of a community with like minded individuals exploring together how to live with nature, and trying to grow/produce something rather than just being a consumer are some of the things that drew us towards TVC.' },
  { name: 'Lakshmi Ratnaparke', bio: '', photo: null },
  { name: 'Nirmal & Shalini', summary: 'Nirmal is now retired from being a System Architect in Aerospace R&D; Shalini works for a nonprofit supporting human rights globally.', bio: "Nirmal is now retired from being a System Architect doing R&D for an Aerospace company. Shalini continues to work for a not for profit foundation supporting human rights organizations globally. They now live in Santa Fe, New Mexico (in the US), where Nirmal volunteers with several organizations focused on education. He is also passionate about ways to passively cool homes, extract water from the atmosphere, and create an innovation commons. Shalini is building her network of people working on social justice, and plans to create a Doughnut Economics Action Lab in Santa Fe.", photo: '/images/members/nirmal-and-shalini.jpg', photoFull: '/images/members/nirmal-and-shalini-full.jpg', family: "Shalini and Nirmal enjoy the numerous music concerts, art and culture offerings of Santa Fe, while also attending talks organized by the Santa Fe Institute — one of the world's leading research centers for complex systems science. Both also enjoy hiking and visiting national parks. They love visits with their grandchildren (two boys, ages 5 and 3) and Shalini's niece's boys (ages 8 and 3).", whyTVC: 'We have always been interested in intentional communities. Having the opportunity to be part of one is exciting.' },
  { name: 'Nishant Gupta', bio: '', photo: null },
  { name: 'Pradeep Kumar Dileep', bio: '', photo: null },
  { name: 'Renuka & Rajesh', bio: 'Renuka has interests in permaculture, with vast amount of knowledge on trees and plants. Rajesh works for Travelopia. ', photo: '/images/members/rajesh-and-renuka.jpg' },
  { name: 'Rajiv & Kritika', bio: 'Rajiv moved out of corporate & now engages with Deshpande Foundation and Rainmatter Foundation in their journeys. Krithika leads the marketing division at Saahas Zero Waste.', photo: '/images/members/rajiv-and-kritika.jpg' },
  { name: 'Ramesh & Sarika', summary: 'Ramesh runs Food Safety Works, a food-safety compliance firm; Sarika is a Food Technologist there.', bio: 'Ramesh runs Food Safety Works, a food safety regulatory and compliance company. Sarika is a Food Technologist who works with him there.', photo: '/images/members/ramesh-and-sarika.jpg', family: 'Ramesh and Sarika have two daughters: Isika, a lawyer, and Chhavi, who is studying Culinary Science.', familyNames: ['Isika', 'Chhavi'], whyTVC: 'Started TVC to build a community of like minded individuals who would like to lead a life that takes less from the planet.', social: ['https://www.linkedin.com/in/notagarwal/'] },
  { name: 'Ramjee & Harshadha', bio: 'Ramjee is a tech enthusiast, runs his AI/ML startup. Harshada is a civil/env engineer.', photo: '/images/members/ramjee-and-harshadha.jpg' },
  { name: 'Reva & Ranjan', bio: 'Reva and Ranjan run Primalise, a firm that works in the area of socio-cultural and natural systems.', photo: '/images/members/reva-and-ranjan.jpg' },
  { name: 'Rishi & Renjana', bio: '', photo: null },
  { name: 'Sameer & Shubha', bio: 'Sameer runs Linger Leisures and Beforest. Shubha works on water sustainability as part of Biome.', photo: '/images/members/sameer-and-shubha.jpg' },
  { name: 'Sameet & Soumya', bio: 'Sameet is a senior consultant at NCR Atleos, working in the ATM and payments domain.', photo: '/images/members/sameet-and-soumya.jpg', family: 'Sameet and Soumya are married with two children, Savitri (19) and Pramith (15).', familyNames: ['Savitri', 'Pramith'], whyTVC: 'Like nature, like the community’s goals and the idea of building something that will do good and outlast me.' },
  { name: 'Sandeep & Supriya', bio: 'Sandeep runs a Sales Enablement SaaS startup. Supriya after a corporate career in Finance, is running her own food biz now.', photo: '/images/members/sandeep-and-supriya.jpg' },
  { name: 'Sanket & Surabhi', bio: 'Sanket works in software, and aspires to be a writer. Surabhi works for HP, also busy dealing with kids and pursuing her hobbies.', photo: '/images/members/sanket-and-surabhi.jpg' },
  { name: 'Shalini & Amit Jain', bio: 'Amit is a Program Manager at HPE. Shalini enjoys baking, gardening, and anything that challenges her creative mind.', photo: '/images/members/shalini-and-amit-jain.jpg' },
  { name: 'Shameek & Gitanjali', bio: 'Shameek and Gitanjali run the venture Farmizen. Gitanjali also runs an urban gardening business - GreenMyLife.', photo: '/images/members/shameek-and-gitanjali.jpg' },
  { name: 'Sharath & Deepa', summary: 'Sharath is a Principal Software Engineer at Shell; Deepa heads the global help desk at Sobis.', bio: 'Sharath works for Shell as a Principal Software Engineer and is a firm believer in sustainable living; outside of work, he spends his time actively participating in the growth and development of the Tamarind Valley Collective. Deepa works for Sobis Software and heads their Global Helpdesk.', photo: '/images/members/sharath-and-deepa.jpg', family: 'Sharath and Deepa are parents to two children: Deesha, who is currently pursuing a Master’s in Ecology and Evolutionary Biology at the University of Helsinki, and Aryaan, who recently completed his undergraduate degree with a major in Mathematics. They also have a 10-year-old cat named Thalia.', familyNames: ['Deesha', 'Aryaan', 'Thalia'], whyTVC: 'We joined TVC because we wanted to create something of lasting value that money simply cannot buy, while fostering a deeper connection with the land and a like-minded community.', social: ['https://www.linkedin.com/in/sharathjeppu/'] },
  { name: 'Shashi & Shobha', bio: 'Sashi works as a Salesforce consultant for Digile. Shobha is a lawyer by education and an artist by choice.', photo: '/images/members/shashi-and-shobha.jpg' },
  { name: 'Shubh & Ranjini', bio: 'Shubh is a techie, works for RJT. Ranjini is a teacher at COMMITS (by day) and a writer (by night.)', photo: '/images/members/shubh-and-ranjini.jpg' },
  { name: 'Sree & Prameela', summary: 'Sree is a Practice Director in SAP/cloud transformation; Prameela is a UX designer at TCS.', bio: 'Sree is a Practice Director, helping customers define their SAP and cloud transformation journey. Prameela is a UX designer at TCS in New Jersey, shaping how people experience digital products.', photo: '/images/members/sree-and-prameela.jpg', photoFull: '/images/members/sree-and-prameela-full.jpg', family: 'Sree and Prameela are married with one son, Sumant (23). Sree is a movie buff; Prameela enjoys gardening and word/board games. Sumant practically lives online.', familyNames: ['Sumant'], whyTVC: ['Wanted to be away from the crowded city life and live close to the nature during retirement years.', 'I loved the idea of doing my part to give back to the earth, and being part of a community gives me the chance to do it alongside people who actually walk the talk.'], social: ['https://linkedin.com/in/pbsreedhar', 'https://linkedin.com/in/prameelajeppu'] },
  { name: 'Suneetha Krishnaveni', bio: 'Suneetha is making a living in Oslo, while dreaming of getting back to our roots. Iyappan and Krishnaveni are Suneetha’s parents.', photo: '/images/members/suneetha-krishnaveni.jpg' },
  { name: 'Swami & Vidhya', bio: 'Swami worked for Capgemini, Srividya quit her IT career and is currently a montessorian & special educator.', photo: '/images/members/swami-and-vidhya.jpg' },
  { name: 'Swayambhu & Mukthi', bio: 'Swayambhu is working with McAfee. Mukti teaches in an engineering college.', photo: '/images/members/swayambhu-and-mukthi.jpg' },
  { name: 'Tarang Puranik', bio: '', photo: null },
  { name: 'Thejesh & Anjana', bio: 'Thejesh is a technologist from Bangalore. Anjana is a writer and editor from Thrissur. She heads communications at CSEI @Atree.', photo: '/images/members/thejesh-and-anjana.jpg' },
  { name: 'Udhay & Lavanya', summary: 'Udhay helps startup founders with strategy, marketing, and fundraising; Lavanya manages their apartment association.', bio: 'Udhay helps startup founders navigate strategy, marketing, and fundraising. Lavanya manages too many things, including the sanitation aspects of their apartment association.', photo: '/images/members/udhay-and-lavanya.jpg', family: 'Udhay and Lavanya have one daughter, Apsara, a recent graduate in Psychology and Journalism.', familyNames: ['Apsara'], whyTVC: 'It’s important to us to have a Plan B outside the city.', social: ['https://linkedin.com/in/udhay'] },
  { name: 'Vasu Mishra', bio: '', photo: null },
  { name: 'Vidya Atherya', bio: '', photo: null },
  { name: 'Vijay & Sunita', bio: 'Vijay is an Electrical Engineer and designs energy efficient solutions for industrial and residential use. Sunita is an artist with many creative learnings.', photo: '/images/members/vijay-and-sunita.jpg' },
  { name: 'Vij & Piya', bio: 'Vij is a software engineer, currently with Google, Bangalore. Piya graduated from the School of Architecture and Planning (SPA). She runs a startup in the financial inclusion space that publishes an app called MeraBills.', photo: '/images/members/vij-and-piya.jpg' },
  { name: 'Vishnu Kumar Agrawal', bio: '', photo: null },
  { name: 'Shilpa & Aditya', bio: "Shilpa is a development finance professional with nearly 20 years across institutions like the World Bank and the Reserve Bank Innovation Hub, and a published children's book author. Aditya has nearly 20 years in B2C e-commerce, across Myntra, Amazon, and Cleartrip.", photo: '/images/members/shilpa-and-aditya.jpg' },
];

// The "53 families" figure quoted in prose across Home/About/People/Members/
// Join was previously hand-typed independently in ~8 places, with nothing
// keeping them in sync with this array (the actual source of truth) if
// membership ever changes. Derive it here instead so every consumer reads
// the real count.
export const MEMBER_FAMILY_COUNT = members.length;

// A stable per-card anchor id (e.g. "sree-and-prameela") for the Members
// page grid and this file's own SiteSearch consumer. Same "-and-"
// convention as the existing photo filenames for readability. Names in
// this list are unique so this can't collide.
export function memberSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
