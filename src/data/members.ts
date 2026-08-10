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
  { name: 'Om & Pavithra', bio: '', photo: null },
  { name: 'Ananth & Manasa', bio: 'Ananth is a program manager with Amazon. Manasa is a marketing manager with Citrix, with interests in traveling, fitness among other things.', photo: '/images/members/ananth-and-manasa.jpg' },
  { name: 'Anil & Roopa', bio: '', photo: null },
  { name: 'Ankur & Kavitha', bio: 'Ankur and Kavitha are faculty at IIM Ahmedabad in Public Policy and Computer Science respectively.', photo: '/images/members/ankur-and-kavitha.jpg' },
  { name: 'Anu & Balu', bio: 'Balu is a techie, works with McAfee. Anu is in the education space, cofounded Tide Learning, which works in the early childhood and primary education area.', photo: '/images/members/anu-and-balu.jpg' },
  { name: 'Arun & Uthara', bio: 'Arun heads the strategy division in Grameen Koota (MFI.) Uthara is discovering social change through 2 NGOs - Buzz Women and Avantika Foundation.', photo: '/images/members/arun-and-uthara.jpg' },
  { name: 'Ashirwad & Harshadha', bio: 'Ashirwad is an IT professional. Harshada is an Ayurvedic doctor by education and also a passionate cook.', photo: '/images/members/ashirwad-and-harshadha.jpg' },
  { name: 'Aunindo & Manoshi', bio: '', photo: null },
  { name: 'Sundar & Anitha', bio: 'Sundar is an IT professional who is also into wildlife, herpetology, biking and languages. Anitha is also a nature lover, loves to grow vegetables, do composting etc..', photo: '/images/members/sundar-and-anitha.jpg' },
  { name: 'Rajavel & Vidhya', bio: 'Rajavel is now a teacher in the field of software design. Vidhya is an early childhood special educator and has interests in dance, fitness and gardening.', photo: '/images/members/rajavel-and-vidhya.jpg' },
  { name: 'Divya & Sudhir', bio: 'Sudhir works with ThoughtWorks. Divya heads the NGO arm of Saahas.', photo: '/images/members/divya-and-sudhir.jpg' },
  { name: 'Harishri Babuji', bio: '', photo: null },
  { name: 'Kaushik Raghunath', bio: '', photo: null },
  { name: 'Pradeep & Ramya', bio: 'Pradeep is a chip designer by profession, also a public policy enthusiast. Ramya is a Doctor.', photo: '/images/members/k-b-pradeep.jpg' },
  { name: 'Kiran & Zainab', bio: 'Zainab and Kiran live in Kodihalli and work in Indiranagar.', photo: '/images/members/kiran-and-zainab.jpg' },
  { name: 'Ram & Krishna', bio: 'Ram worked in Philips Software/TP Vision. Krishna is with Azim Premji Foundation, working as Technology Portfolio lead for the University (APU). She also publishes the podcast New Indian Woman.', photo: '/images/members/ram-and-krishna.jpg' },
  { name: 'Lakshmi & Vijay', bio: '', photo: null },
  { name: 'Nirmal & Shalini', bio: 'Nirmal is a System Architect doing R&D for an Aerospace company. Shalini works for a not for profit foundation supporting human rights organizations globally.', photo: '/images/members/nirmal-and-shalini.jpg' },
  { name: 'Nishant & Neeti', bio: '', photo: null },
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
  { name: 'Sree & Prameela', summary: 'Sree is a Practice Director in SAP/cloud transformation; Prameela is a UX designer at TCS.', bio: 'Sree is a Practice Director, helping customers define their SAP and cloud transformation journey. Prameela is a UX designer at TCS in New Jersey, working to make digital products less confusing.', photo: '/images/members/sree-and-prameela.jpg', family: 'Sree and Prameela are married with one son, Sumant (23). Sree is a movie buff; Prameela enjoys gardening and word/board games. Sumant practically lives online.', familyNames: ['Sumant'], whyTVC: ['Wanted to be away from the crowded city life and live close to the nature during retirement years.', 'I loved the idea of doing my part to give back to the earth, and being part of a community gives me the chance to do it alongside people who actually walk the talk.'], social: ['https://linkedin.com/in/pbsreedhar', 'https://linkedin.com/in/prameelajeppu'] },
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
