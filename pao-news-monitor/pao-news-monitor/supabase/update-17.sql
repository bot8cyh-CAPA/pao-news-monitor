-- PAO News Monitor - update 17: a background profile for each PAO (pilot: 3 PAOs)
-- Safe to run more than once.
--
-- Adds two columns to the member list:
--   profile          short plain-text background on the PAO (who they are, leaders, what they are doing,
--                    how they connect to CAPA, gaps, and the public sources behind each line)
--   profile_checked  the date a person last checked the profile against its sources
-- Ask AI shows the profile to the AI as "Background on file", kept separate from the numbered news
-- items, so a question like "profile CA Sri Lanka" can use it. Public facts only - nothing confidential.
-- After this, redeploy Ask AI (same command as before) so it starts using the profiles.

alter table paos add column if not exists profile         text;
alter table paos add column if not exists profile_checked date;

-- ---- Pilot profiles (drafted 30 Oct 2026 from public pages; staff to correct) ----

update paos set profile_checked = date '2026-10-30', profile = $card$
WHO: CPA Australia, founded 1886. Over 174,000 members in more than 100 countries, 19 offices (the member figure is the 31 December 2023 snapshot, so it is likely higher or lower now).
LEADERSHIP (as of 30 Sep 2026): Warren McRae FCPA is President and Chair from 1 October 2026 for 12 months, succeeding Dale Pinto FCPA, who completed his three-year term. Deputy Presidents: Louise Cox FCPA and Julie Crisp FCPA. CEO: Chris Freeland AM.
NOW: CPA Congress 2026, "Lead the Outcome": Melbourne 20-22 Oct, virtual 23 Oct, Hong Kong 29 Oct, Kuala Lumpur 5 Nov. Member engagement survey closes 2 Nov 2026. By-law changes on regulatory standards and professional conduct took effect 1 Oct 2026. Stated values: transparency, accountability, inclusivity.
CAPA LINK: Priya Terumalay, Head of SEA, is a CAPA board member (per CAPA staff, 30 Oct 2026; not checked against a public page).
NOT KNOWN: breakdown of members by country.
SOURCES: cpaaustralia.com.au/about-us/our-organisation/our-members ; cpaaustralia.com.au/about-cpa-australia/our-organisation/updates-from-the-board/update-from-the-cpa-australia-board-30-september-2026 ; annualreport.cpaaustralia.com.au/organisation/presidents-report
$card$ where id = 'cpa-australia';

update paos set profile_checked = date '2026-10-30', profile = $card$
WHO: Institute of Chartered Accountants of Sri Lanka (CA Sri Lanka), formed 30 January 1959 by Act of Parliament No. 23 of 1959, based in Colombo. Member of IFAC and CAPA; founder member of SAFA.
LEADERSHIP: Tishan Subasinghe is the 28th President, inducted 20 January 2026 (theme "CONNECT"; said "Accountancy is not a dying profession, but a fast-changing one"). Vice President: Anoji de Silva (Senior Partner, EY Sri Lanka and Maldives). The IFAC President, Jean Bouquot, was chief guest at the induction. CEO: Lakmali Priyangika (as of November 2025). Previous President: Heshana Kuruppu.
RECENT: Inaugural Sustainability Summit, 26 May 2026, Colombo, on building resilience (sustainability in corporate strategy, green finance). Record 617 new Chartered Accountants admitted at the November 2025 convocation.
NOT KNOWN: current membership size (an undated 7,000 members appears on Wikipedia and is not relied on); formal relationship with CAPA beyond membership.
SOURCES: ft.lk/business/Tishan-Subasinghe-takes-the-reins-as-28th-President-of-CA-Sri-Lanka/34-787212 ; ft.lk/sustainability__environment/CA-Sri-Lanka-unveils-Inaugural-Sustainability-Summit-2026/10519-791834 ; ft.lk/hr/CA-Sri-Lanka-convocation-sees-record-617-new-Chartered-Accountants/47-784099 ; en.wikipedia.org/wiki/Institute_of_Chartered_Accountants_of_Sri_Lanka
$card$ where id = 'ca-sri-lanka';

update paos set profile_checked = date '2026-10-30', profile = $card$
WHO: Fiji Institute of Chartered Accountants (FICA), a statutory body under the Fiji Institute of Chartered Accountants Act 2021 (Act No. 44 of 2021). It regulates the practice of accountancy in Fiji, keeps the register of Chartered Accountants, Associate Accountants and Accounting Technicians, and runs complaints and discipline (sanctions include removal from the register and suspension of up to 5 years).
LEADERSHIP: Sharvek Naidu (KPMG partner) became President at the 53rd AGM on 6 June 2025. Vice President: Ravinesh Singh. Treasurer: Shaneel Nandan. Stated priorities for his term: members' professional skills, stakeholder partnerships, ethical standards, operational efficiency.
RECENT: FICA Congress, 8-9 May 2026, Nadi, "Charting New Horizons for a Changing World". Three pillars: global economics and Fiji's position; digital transformation and AI; sustainable governance.
NOT KNOWN: membership size; formal relationship with CAPA beyond membership.
SOURCES: pacliirms.austlii.edu.au/fj/legis/num_act/fiocaa2021391 ; fijiglobalnews.com/fica-welcomes-new-leadership-a-vision-for-growth-and-innovation ; fijiglobalnews.com/fica-announces-2026-congress-in-nadi-secures-153750-in-sponsorships-for-may-8-9 ; fijiglobalnews.com/fijis-fica-congress-2026-to-chart-new-horizons-with-ai-macroeconomics-and-sustainable-governance
$card$ where id = 'fica';

notify pgrst, 'reload schema';
