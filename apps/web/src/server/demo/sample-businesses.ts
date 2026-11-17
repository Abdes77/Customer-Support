import type { KnowledgeCategory } from "@repo/core";

/*
 * The sample businesses of the public demo site (`pnpm demo:setup`). They are invented: the
 * names, people, phone numbers (555 numbers), reviews and license numbers belong to nobody.
 * Each one is an ordinary business of the agency once stored: its facts can be edited in the
 * admin panel like any client's, and a later `pnpm demo:setup` leaves hand-edited facts alone.
 */

export interface SampleFact {
  readonly category: KnowledgeCategory;
  readonly title: string;
  readonly content: string;
}

export interface SampleBusiness {
  /** Stable reference (`businesses.external_ref` is `demo:<ref>`): how a re-run finds it. */
  readonly ref: string;
  /** The trade as the demo site lists it, and the segment the business is put in. */
  readonly segment: { readonly name: string; readonly slug: string };
  readonly profile: {
    readonly name: string;
    readonly timezone: string;
    readonly phone: string;
    readonly email: string;
    readonly addressLine1: string;
    readonly city: string;
    readonly state: string;
    readonly postalCode: string;
  };
  readonly botName: string;
  /** The chat's color: the bubble, the header, the visitor's messages. */
  readonly color: string;
  readonly opening: string;
  readonly teaser: string;
  /** Places served, for `qualification.service_area.cities`. */
  readonly cities: readonly string[];
  /** Whether its facts promise an on-call crew outside office hours (`emergency.service_level`). */
  readonly onCall: boolean;
  /** Mon to Fri and Saturday hours ("HH:MM"); null: closed on Saturday. */
  readonly hours: {
    readonly weekdays: readonly [string, string];
    readonly saturday: readonly [string, string] | null;
  };
  readonly facts: readonly SampleFact[];
}

export const SAMPLE_BUSINESSES: readonly SampleBusiness[] = [
  {
    ref: "roofing",
    segment: { name: "Roofing", slug: "roofing" },
    profile: {
      name: "Ironwood Roofing",
      timezone: "America/Denver",
      phone: "(303) 555-0142",
      email: "office@ironwoodroofing.example",
      addressLine1: "2180 Kipling Street",
      city: "Lakewood",
      state: "CO",
      postalCode: "80215",
    },
    botName: "Riley",
    color: "#9a3412",
    opening:
      "Hi, I'm {{bot_name}}, the AI assistant at {{business_name}}. Leak, storm damage or time for a new roof? Tell me what's going on and I'll get you sorted.",
    teaser: "Roof trouble? Ask {{bot_name}}.",
    cities: ["Lakewood", "Denver", "Arvada", "Golden", "Wheat Ridge", "Littleton", "Englewood"],
    onCall: true,
    hours: { weekdays: ["07:00", "18:00"], saturday: ["08:00", "13:00"] },
    facts: [
      {
        category: "services",
        title: "Roof repair",
        content:
          "Leak tracing and repair, missing or lifted shingles, flashing around chimneys, skylights and vents, pipe boots, and small sections of rotted decking. Most repairs are finished in one visit.",
      },
      {
        category: "services",
        title: "Roof replacement",
        content:
          "Full tear-off and replacement with asphalt architectural shingles, Class 4 impact-resistant shingles or standing-seam metal. A typical single-family home takes one to two days once materials are on site.",
      },
      {
        category: "services",
        title: "Storm and hail damage",
        content:
          "Free hail and wind damage inspections with photos. The team meets the insurance adjuster on the roof and writes the estimate in the format insurers use.",
      },
      {
        category: "services",
        title: "Gutters",
        content:
          "Seamless 5-inch and 6-inch aluminum gutters, downspouts and gutter guards, installed on their own or together with a new roof.",
      },
      {
        category: "services",
        title: "What Ironwood does not do",
        content:
          "No flat commercial roofs over 5,000 square feet, no solar panel removal or reinstallation, and no interior drywall or paint repair after a leak.",
      },
      {
        category: "service_area",
        title: "Where the crews work",
        content:
          "The west Denver metro: Lakewood, Denver, Arvada, Golden, Wheat Ridge, Littleton and Englewood. Roughly 25 minutes from the Lakewood shop.",
      },
      {
        category: "hours",
        title: "Office hours",
        content:
          "Monday to Friday 7 am to 6 pm, Saturday 8 am to 1 pm, closed Sunday. For an active leak the on-call crew does emergency tarping in the evening and at weekends.",
      },
      {
        category: "licenses",
        title: "Licensed and insured",
        content:
          "Licensed roofing contractor in Lakewood, Denver and Arvada, with general liability and workers' compensation insurance. Certificates are sent on request.",
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "10-year workmanship warranty on full replacements and 2 years on repairs, on top of the shingle manufacturer's own warranty.",
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Financing is offered through a lending partner for replacements, subject to credit approval. The estimator brings the current plans to the inspection.",
      },
      {
        category: "pricing",
        title: "Inspections and estimates",
        content:
          "Roof inspections and written estimates are free. Prices are quoted after someone has been on the roof, never over chat or phone.",
      },
      {
        category: "team",
        title: "Who you will meet",
        content:
          "Family-owned since 2009. Dana Whitfield runs the office and schedules inspections; Marcus Hale and Luis Ortega are the two estimators.",
      },
      {
        category: "reviews",
        title: "What customers say",
        content:
          '"They found a leak two other roofers missed and fixed it the same afternoon." (Priya, Lakewood). "Handled the whole hail claim with our insurer." (Tom, Arvada).',
      },
    ],
  },
  {
    ref: "hvac",
    segment: { name: "HVAC", slug: "hvac" },
    profile: {
      name: "Northlake Heating & Air",
      timezone: "America/Chicago",
      phone: "(612) 555-0117",
      email: "service@northlakeheating.example",
      addressLine1: "4410 Lyndale Avenue South",
      city: "Minneapolis",
      state: "MN",
      postalCode: "55419",
    },
    botName: "Sam",
    color: "#0e7490",
    opening:
      "Hi, I'm {{bot_name}}, the AI assistant at {{business_name}}. Furnace acting up, AC not keeping up, or thinking about a new system? Tell me what's happening.",
    teaser: "No heat? Ask {{bot_name}}.",
    cities: ["Minneapolis", "St. Paul", "Edina", "Bloomington", "Richfield", "St. Louis Park"],
    onCall: true,
    hours: { weekdays: ["07:00", "19:00"], saturday: ["08:00", "16:00"] },
    facts: [
      {
        category: "services",
        title: "Furnace and boiler repair",
        content:
          "Diagnosis and repair of gas furnaces and hot-water boilers of every major brand: no heat, short cycling, strange noises, pilot and ignition faults, blower and inducer motors.",
      },
      {
        category: "services",
        title: "Air conditioning repair",
        content:
          "Central air conditioners and heat pumps: not cooling, frozen coils, refrigerant leaks, capacitors, condenser fan motors and thermostat problems.",
      },
      {
        category: "services",
        title: "New systems",
        content:
          "Replacement and new installation of furnaces, central air, cold-climate heat pumps and ductless mini-splits. A comfort advisor measures the home first; most installs take one day.",
      },
      {
        category: "services",
        title: "Maintenance plan",
        content:
          "The Comfort Club covers one heating tune-up and one cooling tune-up a year, priority scheduling and a discount on repairs.",
      },
      {
        category: "services",
        title: "What Northlake does not do",
        content:
          "No commercial rooftop units, no refrigeration (walk-in coolers, ice machines) and no duct cleaning.",
      },
      {
        category: "service_area",
        title: "Where the technicians go",
        content: "Minneapolis, St. Paul, Edina, Bloomington, Richfield and St. Louis Park.",
      },
      {
        category: "hours",
        title: "Office hours",
        content:
          "Monday to Friday 7 am to 7 pm, Saturday 8 am to 4 pm. A technician is on call around the clock from October to April for no-heat calls.",
      },
      {
        category: "licenses",
        title: "Licensed and insured",
        content:
          "Licensed mechanical contractor in Minnesota, bonded and insured. Every technician is NATE-certified and background-checked.",
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "1-year parts and labor warranty on repairs. New systems carry the manufacturer's 10-year parts warranty and a 2-year labor warranty.",
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Monthly payment plans for new systems through a lending partner, subject to credit approval. Utility rebates are filed for the customer where the equipment qualifies.",
      },
      {
        category: "pricing",
        title: "Service calls and estimates",
        content:
          "A repair visit starts with a diagnostic fee that the technician confirms when booking, and it is credited toward the repair when the work is approved. Estimates for a new system are free.",
      },
      {
        category: "brands",
        title: "Brands",
        content:
          "Installs Carrier, Bryant and Mitsubishi Electric equipment and services every major brand.",
      },
      {
        category: "reviews",
        title: "What customers say",
        content:
          '"Furnace quit at 9 pm in January and they had heat back before midnight." (Karen, Edina). "No pressure, three options, clear numbers." (Abdi, Minneapolis).',
      },
    ],
  },
  {
    ref: "plumbing",
    segment: { name: "Plumbing", slug: "plumbing" },
    profile: {
      name: "Tidewell Plumbing",
      timezone: "America/New_York",
      phone: "(813) 555-0163",
      email: "hello@tidewellplumbing.example",
      addressLine1: "3305 West Kennedy Boulevard",
      city: "Tampa",
      state: "FL",
      postalCode: "33609",
    },
    botName: "Jordan",
    color: "#1d4ed8",
    opening:
      "Hi, I'm {{bot_name}}, the AI assistant at {{business_name}}. Leak, clog, water heater or something else? Tell me what's going on.",
    teaser: "Plumbing problem? Ask {{bot_name}}.",
    cities: ["Tampa", "St. Petersburg", "Brandon", "Riverview", "Temple Terrace", "Clearwater"],
    onCall: true,
    hours: { weekdays: ["07:00", "18:00"], saturday: ["08:00", "14:00"] },
    facts: [
      {
        category: "services",
        title: "Leaks and repairs",
        content:
          "Leaking and burst pipes, slab leaks, running toilets, dripping faucets, shut-off valves, hose bibs and garbage disposals.",
      },
      {
        category: "services",
        title: "Drains and sewers",
        content:
          "Clogged sinks, tubs, toilets and main lines, cleared by cable or hydro-jetting. Sewer camera inspections with a video the customer keeps.",
      },
      {
        category: "services",
        title: "Water heaters",
        content:
          "Repair and replacement of tank and tankless water heaters, gas and electric. A standard tank replacement is usually done the same or the next day.",
      },
      {
        category: "services",
        title: "Repiping and fixtures",
        content:
          "Whole-home repipes of older polybutylene and galvanized lines, plus installation of toilets, faucets, sinks and water filtration systems.",
      },
      {
        category: "services",
        title: "What Tidewell does not do",
        content:
          "No septic tank pumping, no irrigation or sprinkler systems, and no pool plumbing.",
      },
      {
        category: "service_area",
        title: "Where the plumbers go",
        content: "Tampa, St. Petersburg, Brandon, Riverview, Temple Terrace and Clearwater.",
      },
      {
        category: "hours",
        title: "Office hours",
        content:
          "Monday to Friday 7 am to 6 pm, Saturday 8 am to 2 pm. A plumber is on call at night and on Sundays for burst pipes, sewage backups and water that cannot be shut off.",
      },
      {
        category: "licenses",
        title: "Licensed and insured",
        content:
          "State-certified plumbing contractor in Florida, licensed, bonded and insured. Permits are pulled for water heaters and repipes.",
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "1-year warranty on repairs, 6 years on tank water heaters the team installs and a lifetime warranty on whole-home repipes.",
      },
      {
        category: "pricing",
        title: "Pricing approach",
        content:
          "Upfront, flat-rate pricing: the plumber looks at the job, gives a price in writing, and it does not change. No overtime rate on Saturdays.",
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Payment plans for repipes, sewer line work and water heaters through a lending partner, subject to credit approval.",
      },
      {
        category: "differentiators",
        title: "Why customers call Tidewell",
        content:
          "Plumbers wear shoe covers and lay down floor protection, text a photo and an arrival time before they come, and clean up before they leave.",
      },
      {
        category: "reviews",
        title: "What customers say",
        content:
          '"Water heater died on a Friday, new one in by Saturday noon." (Elena, Tampa). "Showed me the camera video of the root in the line. No guessing." (Greg, Brandon).',
      },
    ],
  },
  {
    ref: "electrical",
    segment: { name: "Electrical", slug: "electrical" },
    profile: {
      name: "Brightwire Electric",
      timezone: "America/Chicago",
      phone: "(512) 555-0188",
      email: "office@brightwireelectric.example",
      addressLine1: "5120 Burnet Road",
      city: "Austin",
      state: "TX",
      postalCode: "78756",
    },
    botName: "Alex",
    color: "#b45309",
    opening:
      "Hi, I'm {{bot_name}}, the AI assistant at {{business_name}}. Outlet not working, panel upgrade, EV charger? Tell me what you need.",
    teaser: "Electrical question? Ask {{bot_name}}.",
    cities: ["Austin", "Round Rock", "Cedar Park", "Pflugerville", "Lakeway", "Georgetown"],
    onCall: true,
    hours: { weekdays: ["07:30", "17:30"], saturday: null },
    facts: [
      {
        category: "services",
        title: "Troubleshooting and repairs",
        content:
          "Dead outlets and circuits, breakers that keep tripping, flickering lights, buzzing switches, aluminum wiring repairs and storm damage to the service mast.",
      },
      {
        category: "services",
        title: "Panels and service upgrades",
        content:
          "Replacement of outdated and recalled panels, upgrades from 100 to 200 amps, sub-panels, whole-home surge protection. Brightwire handles the permit and the utility disconnect.",
      },
      {
        category: "services",
        title: "EV chargers",
        content:
          "Level 2 EV charger installation for every make, including the load calculation that tells whether the panel can carry it.",
      },
      {
        category: "services",
        title: "Lighting, fans and wiring",
        content:
          "Recessed lighting, ceiling fans, under-cabinet and landscape lighting, dedicated circuits for appliances, and wiring for remodels and additions.",
      },
      {
        category: "services",
        title: "Generators",
        content:
          "Standby generator installation with an automatic transfer switch, and interlock kits for portable generators.",
      },
      {
        category: "services",
        title: "What Brightwire does not do",
        content:
          "No solar panel installation, no low-voltage work such as security cameras or network cabling, and no appliance repair.",
      },
      {
        category: "service_area",
        title: "Where the electricians go",
        content: "Austin, Round Rock, Cedar Park, Pflugerville, Lakeway and Georgetown.",
      },
      {
        category: "hours",
        title: "Office hours",
        content:
          "Monday to Friday 7:30 am to 5:30 pm. An electrician is on call in the evening and at weekends for power loss, burning smells and sparking.",
      },
      {
        category: "licenses",
        title: "Licensed and insured",
        content:
          "Texas-licensed electrical contractor with a master electrician on staff, fully insured. Every job that needs a permit gets one and is inspected by the city.",
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "2-year workmanship warranty on repairs and 5 years on panel upgrades. Equipment carries the manufacturer's warranty.",
      },
      {
        category: "pricing",
        title: "Estimates",
        content:
          "Estimates for panels, EV chargers, generators and remodel wiring are free and given in writing after a visit. Repairs start with a diagnostic visit whose fee the office confirms when booking.",
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Payment plans through a lending partner for panel upgrades and generators, subject to credit approval.",
      },
      {
        category: "reviews",
        title: "What customers say",
        content:
          '"Found the bad connection behind an outlet that had been tripping the breaker for a year." (Monica, Round Rock). "Charger installed and inspected in three days." (Raj, Austin).',
      },
    ],
  },
  {
    ref: "remodeling",
    segment: { name: "Kitchen & bath remodeling", slug: "kitchen-and-bath-remodeling" },
    profile: {
      name: "Maple & Stone Remodeling",
      timezone: "America/New_York",
      phone: "(614) 555-0126",
      email: "studio@mapleandstone.example",
      addressLine1: "780 North High Street",
      city: "Columbus",
      state: "OH",
      postalCode: "43215",
    },
    botName: "Casey",
    color: "#4d7c0f",
    opening:
      "Hi, I'm {{bot_name}}, the AI assistant at {{business_name}}. Planning a kitchen or bathroom? Tell me a bit about the space and what you'd like to change.",
    teaser: "Planning a remodel? Ask {{bot_name}}.",
    cities: ["Columbus", "Dublin", "Upper Arlington", "Westerville", "Worthington", "Bexley"],
    onCall: false,
    hours: { weekdays: ["08:30", "17:30"], saturday: ["10:00", "14:00"] },
    facts: [
      {
        category: "services",
        title: "Kitchen remodels",
        content:
          "Full kitchen remodels: design, cabinets, countertops, tile, lighting, plumbing and electrical, including moving walls and layouts. Cabinet refacing and countertop-only projects are also taken.",
      },
      {
        category: "services",
        title: "Bathroom remodels",
        content:
          "Full bathroom remodels, tub-to-shower conversions, walk-in and curbless showers, vanities, tile and heated floors. Accessible bathrooms with grab bars and wider doorways.",
      },
      {
        category: "services",
        title: "Design",
        content:
          "Every project starts with an in-home consultation and a 3D design. An in-house designer helps choose cabinets, counters, tile and fixtures at the Columbus showroom.",
      },
      {
        category: "services",
        title: "What Maple & Stone does not do",
        content:
          "No whole-house additions, no basement finishing, no exterior work and no single-item handyman repairs such as replacing one faucet.",
      },
      {
        category: "service_area",
        title: "Where the crews work",
        content: "Columbus, Dublin, Upper Arlington, Westerville, Worthington and Bexley.",
      },
      {
        category: "hours",
        title: "Showroom hours",
        content:
          "Monday to Friday 8:30 am to 5:30 pm, Saturday 10 am to 2 pm by appointment. In-home consultations are also offered on weekday evenings.",
      },
      {
        category: "licenses",
        title: "Licensed and insured",
        content:
          "Licensed home improvement contractor in Columbus, insured, and EPA Lead-Safe certified for homes built before 1978. Permits and inspections are handled for the homeowner.",
      },
      {
        category: "warranties",
        title: "Warranty",
        content:
          "5-year workmanship warranty on every remodel. Cabinets, counters and fixtures carry their makers' warranties.",
      },
      {
        category: "financing",
        title: "Financing",
        content:
          "Financing through a lending partner, subject to credit approval. Payments on a project follow milestones: deposit, start of work, cabinets installed, completion.",
      },
      {
        category: "pricing",
        title: "Consultation and estimates",
        content:
          "The in-home consultation is free. A fixed-price proposal follows the design; the price changes only if the homeowner changes the plan.",
      },
      {
        category: "policies",
        title: "How long a project takes",
        content:
          "From signed design to start is usually six to ten weeks, mostly waiting for cabinets. On site, a bathroom takes about three weeks and a kitchen six to eight.",
      },
      {
        category: "differentiators",
        title: "Why homeowners choose Maple & Stone",
        content:
          "One project manager from start to finish, a daily photo update, dust barriers and floor protection, and a crew of employees rather than rotating subcontractors.",
      },
      {
        category: "reviews",
        title: "What customers say",
        content:
          '"Finished two days early and on the number they quoted." (Hannah, Upper Arlington). "The 3D design made the decision easy." (Chris, Dublin).',
      },
    ],
  },
];
