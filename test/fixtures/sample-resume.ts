// A fictional candidate for tests and `npm run sample` (no real person's data).
export const SAMPLE_RESUME = {
  candidate_name: "Jordan A. Example",
  nickname: "Jay",
  position_applied: "Senior Project Manager – Utility Scale Solar",
  summary_header: "PROFESSIONAL SUMMARY",
  professional_summary:
    "Construction leader with 14 years of experience delivering utility-scale solar, substation and transmission projects from preconstruction through energization. Managed portfolios up to $240M and 350 MW with self-perform and subcontracted crews, consistently finishing ahead of schedule with strong safety records.",
  section_order: ["summary", "skills", "certifications", "work", "projects", "education"],
  skills: [
    "Utility-Scale Solar", "Substation Construction", "Project Scheduling (P6)", "Budget Management", "Subcontractor Management",
    "Owner & Utility Relations", "Commissioning", "QA/QC Programs", "Safety Leadership", "Procore", "Change Order Management",
    "Interconnection", "Estimating", "Crew Supervision", "Contract Negotiation", "Risk Management",
  ],
  certifications: [
    { name: "OSHA 30", dates: "May 2017 to Present" },
    { name: "PMP", dates: "June 2019 to June 2025" },
    { name: "CPR / First Aid", dates: "May 2024 to May 2027" },
    { name: "NFPA 70E" },
    { name: "Certified Lineman" },
  ],
  separate_certifications: true,
  work_header: "PROFESSIONAL EXPERIENCE",
  professional_history: [
    {
      company: "Sunfield Energy Constructors",
      roles: [
        {
          title: "Senior Project Manager",
          title_suffix: null,
          start_date: "August 2022",
          end_date: "Present",
          bullets: [
            "Lead delivery of a 350 MW, $240M solar and battery storage project with 6 direct reports and 400+ craft at peak.",
            "Reduced installation schedule by 7 weeks by resequencing pile and tracker work and adding a second-shift crew.",
            "Own owner, utility and AHJ relationships, monthly cost reports and forecast accuracy within 2%.",
          ],
        },
        {
          title: "Project Manager",
          title_suffix: "Substations",
          start_date: "March 2019",
          end_date: "August 2022",
          bullets: ["Managed four 138 kV substation builds valued at $18M–$42M, all energized on schedule.", "Built the division's QA/QC checklist program, now used company-wide."],
        },
      ],
    },
    {
      company: "Midwest Line & Power",
      roles: [
        {
          title: "Construction Superintendent",
          title_suffix: null,
          start_date: "January 2014",
          end_date: "March 2019",
          bullets: ["Supervised self-perform crews of up to 60 on transmission and distribution projects across three states.", "Maintained a 0.8 TRIR over five years."],
        },
      ],
    },
    {
      company: "Example Electric Co-op",
      roles: [{ title: "Lineman", title_suffix: null, start_date: "June 2011", end_date: "January 2014", bullets: ["Built and maintained overhead and underground distribution lines."] }],
    },
  ],
  project_experience: [
    "Prairie Wind Solar 350 MW (Sunfield)", "Cedar Ridge BESS 100 MW (Sunfield)", "Hollow Creek 138 kV Substation (Utility A)", "North Fork 138 kV Substation (Utility B)",
    "Lakeview 69 kV Rebuild (Co-op)", "Grand River Transmission 12 mi (Utility C)", "Meadowbrook Solar 80 MW (Sunfield)",
  ],
  education: [{ institution: "State Technical College", degree_type: "Associate of Applied Science", field: "Electrical Construction", gpa: null, year: "2011", description: null }],
};
