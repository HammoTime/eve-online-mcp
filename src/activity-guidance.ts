export const EVE_ACTIVITY_TYPES = [
  "exploration",
  "factional_warfare",
  "mining",
  "industry",
  "trading",
  "hauling",
  "missions",
  "pve",
  "pvp",
] as const;

export type EveActivity = (typeof EVE_ACTIVITY_TYPES)[number];

interface ActivityGuidance {
  title: string;
  clarify: string;
  evidence: string;
  advice: string;
  limits: string;
}

export const ACTIVITY_GUIDANCE: Record<EveActivity, ActivityGuidance> = {
  exploration: {
    title: "Exploration",
    clarify:
      "Establish the desired security space, data/relic versus broader exploration goal, session length, solo/group preference, scanning experience, and acceptable ship-and-cargo loss. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, and wallet when they materially affect the plan. If an explicit character ID is available and owned alternatives matter, inspect GetCharactersCharacterIdAssets and identify scanning-capable hulls from verified type/group data rather than names alone. Resolve candidate systems, compare routes with GetRouteOriginDestination, and use GetUniverseSystemJumps and GetUniverseSystemKills only as historical activity indicators. Check replacement hull, probe, launcher, and other user-selected item prices with bounded market snapshots.",
    advice:
      "Recommend an executable starting route or area appropriate to the pilot's skills, time, risk tolerance, and replacement budget. Prefer an already-owned suitable hull when practical; otherwise give a short shopping list and a verified public-market source. Include preparation, safe-return and cargo-drop rules, route-security tradeoffs, and the first in-game action.",
    limits:
      "ESI does not expose current cosmic signatures, wormhole connections, local occupants, directional-scan results, or gate camps. Do not call a system safe from aggregate kills or jumps. Tell the pilot to confirm the route and use the in-game map, probe scanner, local intelligence, and directional scanner immediately before and during travel.",
  },
  factional_warfare: {
    title: "Factional warfare",
    clarify:
      "Establish the preferred militia or existing allegiance, solo versus fleet play, plexing versus PvP versus loyalty-point income, session length, ship-size comfort, and loss budget. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for profile, location, ship, skills, and wallet when relevant. Inspect GetCharactersCharacterIdFwStats to verify enlistment and personal history; do not infer enrollment from the goal. Use GetFwWars, GetFwSystems, and optionally GetFwStats to identify the relevant war zone and shortlist owned, contested, or neighboring systems. Resolve system names and compare routes. Inspect GetCharactersCharacterIdAssets for suitable owned hulls before proposing a purchase, and use bounded market snapshots to price the selected hull and essential fit at an accessible public market.",
    advice:
      "If the character is not enlisted, clearly make enlistment through the current in-game Factional Warfare interface the first prerequisite and explain that the MCP cannot perform it. Recommend a starter hull class and concrete candidate compatible with the pilot's verified skills, chosen complex size, and loss budget; prefer a suitable owned ship or provide a priced shopping list and route. Suggest a staging system from the available evidence, explain why it is only a candidate, and tell the pilot how to confirm Frontline, Command Operations, or Rearguard status in the in-game Factional Warfare map. For loyalty points, inspect GetCharactersCharacterIdLoyaltyPoints, then compare only verified offers supplied by the pilot against public market evidence, including required ISK and items, to estimate net ISK per LP.",
    limits:
      "ESI does not expose live plex occupancy, battlefield conditions, current complex ship restrictions, militia-fleet availability, or the loyalty-point store offer catalogue. System ownership and victory-point data can be cached and do not by themselves prove a good fight or a safe destination. Never invent an enrollment state, frontline classification, fit, LP offer, or ISK-per-LP return; direct the pilot to verify these in game.",
  },
  mining: {
    title: "Mining",
    clarify:
      "Establish ore, ice, or gas preference; solo versus fleet play; security-space tolerance; session length; hauling or refining access; and the acceptable ship-loss budget. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, and wallet. With an explicit character ID, inspect every required page of GetCharactersCharacterIdAssets and classify mining-capable hulls using verified universe type, group, and category data; preserve each candidate's actual asset location and nesting instead of assuming it is nearby or accessible. Inspect GetCharactersCharacterIdMining for recent resource types and locations when useful. Resolve asset locations, compare secure and shortest routes, and evaluate accessible public trade hubs rather than assuming Jita is nearest. Use GetMarketsRegionIdHistory for demand context and bounded get_market_snapshot calls for a small evidence-driven shortlist of mineable resources and any needed hull or modules.",
    advice:
      "Start from suitable ships the character already owns and say exactly where they are, how to retrieve them, and whether retrieval is sensible within the session. Otherwise recommend a skill-compatible hull and a bounded replacement-cost shopping list. Recommend a resource focus only after considering verified skills, recent activity, route and security, hauling volume, observed demand, and comparable public buy prices at the destination; state whether selling raw, compressed, or refined material is an assumption requiring an in-game yield check. Give a travel-and-staging plan, cargo-drop rule, and first action.",
    limits:
      "ESI does not reveal current belt, anomaly, ice, or gas-site contents; live threats; fleet boosts; compression availability; the pilot's exact fitted yield; or complete refining economics. A high unit price is not the same as high ISK per hour because cycle time, volume, yield, taxes, hauling, and losses differ. Public market snapshots exclude inaccessible private structure markets. Require in-game confirmation of resource availability, fit, yield, facility access, and executable prices.",
  },
  industry: {
    title: "Industry",
    clarify:
      "Establish manufacturing, research, invention, reactions, or copying; desired scale; available time and capital; owned-blueprint preference; facility access; hauling tolerance; and whether the goal is profit or personal supply. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for skills, wallet, and location when relevant. Inspect GetCharactersCharacterIdBlueprints, GetCharactersCharacterIdAssets, and GetCharactersCharacterIdIndustryJobs for owned blueprints, materials, locations, material/time efficiency, and occupied capacity. Use GetIndustrySystems and GetIndustryFacilities for public cost-index and facility evidence, resolve locations, and compare routes. For a small candidate set with a verified bill of materials, use market history and bounded snapshots for inputs and outputs at accessible public markets.",
    advice:
      "Prefer jobs supported by owned blueprints, verified skills, available materials, capital, and accessible facilities. Show the candidate product, sourcing and hauling plan, facility choice, job duration, cash required, expected output market, and a cost breakdown that includes known fees, taxes, and transport. Treat profit as a scenario with explicit assumptions, compare make-versus-buy when possible, and recommend the smallest sensible trial job plus its first action.",
    limits:
      "ESI does not provide a complete static blueprint recipe database, live facility tax policy, structure access guarantee, invention probability calculation, or executable future sale price. Do not reconstruct a bill of materials or production yield from memory when it has not been verified. Ask the pilot for the in-game industry preview or another current recipe source when required, and label incomplete margin estimates accordingly.",
  },
  trading: {
    title: "Trading",
    clarify:
      "Establish station trading versus regional hauling, starting capital, order-slot and skill constraints, preferred hubs or regions, desired turnover, time available for order management, and acceptable inventory risk. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for wallet, skills, and location when relevant. Inspect GetCharactersCharacterIdOrders, GetCharactersCharacterIdWalletTransactions, and GetCharactersCharacterIdAssets only when the character's existing positions and stock should affect the plan. Use GetMarketsRegionIdHistory for recent volume and price context, bounded get_market_snapshot calls for current observed orders, and route comparisons when inventory must move. Compare accessible public hubs rather than assuming Jita is the right destination.",
    advice:
      "Recommend a small, diversified candidate set supported by observed spread, history, likely turnover, capital, hauling needs, and downside exposure. Show entry and exit locations, suggested maximum capital at risk, known taxes and fees, a conservative break-even calculation, order-management cadence, and a first order or research action. Separate station-trading recommendations from routes that require hauling.",
    limits:
      "Observed spreads are not guaranteed profit: orders can be out of range, have minimum volumes, disappear, or be inaccessible, and bounded snapshots may be incomplete. ESI market history is regional and historical, not proof of present liquidity. Do not present an order as executable without an in-game check, and do not treat private structure markets, broker fees, taxes, or hauling losses as zero when they are unknown.",
  },
  hauling: {
    title: "Hauling",
    clarify:
      "Establish owned-cargo versus courier work, origin and destination, cargo volume and value, collateral, reward, deadline, ship preference, route-security tolerance, and whether scouts or escorts are available. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, and wallet. Inspect GetCharactersCharacterIdAssets for owned haulers and cargo locations, and GetCharactersCharacterIdContracts or public regional contracts only when contract work is requested and visible to the character. Verify cargo and hull properties from universe and dogma data when possible. Resolve endpoints, compare secure and shortest variants with GetRouteOriginDestination, and use GetUniverseSystemKills and GetUniverseSystemJumps only as historical risk indicators. Price the hull, cargo, and collateral exposure from bounded public-market evidence when material.",
    advice:
      "Check that verified capacity, access, collateral, deadline, and wallet support the run before recommending it. Present route alternatives, total jumps, security exposure, cargo-value-to-hull tradeoff, replacement and collateral-at-risk amounts, docking or structure-access assumptions, and operational precautions. Reject or flag economically irrational contracts rather than optimizing only for reward per jump, and give the first in-game verification step; the pilot must accept contracts manually.",
    limits:
      "ESI routes and hourly aggregate activity do not reveal gate camps, bubbles, smartbombers, current scouts, docking rights, or safe passage. Public contracts may be paginated or change before acceptance, and structure access can differ from visibility. Require an immediate in-game route, contract, capacity, collateral, deadline, and access check before undocking.",
  },
  missions: {
    title: "Agent missions",
    clarify:
      "Establish the mission level and type, preferred NPC corporation or faction, current agent or location, standings goal, loyalty-point goal, session length, fleet size, ship preference, and loss budget. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, and wallet. Inspect GetCharactersCharacterIdStandings and GetCharactersCharacterIdLoyaltyPoints for verified access and reward context, and GetCharactersCharacterIdAssets for suitable owned ships when helpful. Resolve any user-supplied agent, corporation, station, and system identifiers, compare routes, and use bounded market evidence for replacement ships, consumables, loot, or verified loyalty-point reward candidates.",
    advice:
      "Recommend a mission level, damage-tank concept, owned or purchasable hull, staging location, preparation list, and session plan consistent with verified skills, standings, and budget. Clearly separate standing progression, ISK, and loyalty-point objectives. For loyalty-point spending, compare only current offers the pilot verifies in the in-game LP Store, including required ISK and items, and provide a first action such as checking an agent, fitting a ship, or moving to the staging station.",
    limits:
      "ESI does not expose the character's offered or active missions, agent catalogue and availability, mission pocket, NPC composition, live damage triggers, or loyalty-point store offer catalogue. Do not invent an exact agent, mission, fit, or optimal LP item. Require the pilot to confirm agent access, mission briefing, damage types, triggers, ship restrictions, and LP offers in game before committing.",
  },
  pve: {
    title: "PvE combat",
    clarify:
      "Establish mission, anomaly, combat-site, escalation, incursion, abyssal, ratting, or other PvE preference; security space; solo versus fleet; session length; experience; ship preference; and acceptable pod and ship loss. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, wallet, and skill queue when relevant. Inspect GetCharactersCharacterIdAssets for suitable owned hulls and GetCharactersCharacterIdKillmailsRecent for loss patterns only when authorized and useful. Use GetIncursions for current incursion locations when that activity is requested, resolve systems, compare routes, and check selected hull, fit, consumable, and loot prices with bounded public-market evidence.",
    advice:
      "Choose a difficulty and activity compatible with verified skills, experience, time, location, and replacement budget. Prefer a suitable owned hull or provide a bounded, priced shopping list. Explain the tank and damage concept without pretending to verify a complete fit, include travel and extraction rules, loss and pod exposure, expected evidence-backed rewards where available, and the first in-game action.",
    limits:
      "Except for incursions, ESI does not expose current anomalies, signatures, escalations, mission pockets, abyssal conditions, NPC waves, triggers, or local threats. It also cannot prove a fit is cap-stable or survivable. Require current in-game site, weather, fit-simulation, fleet-doctrine, and threat checks, and label remembered encounter mechanics or income rates as unverified heuristics.",
  },
  pvp: {
    title: "PvP",
    clarify:
      "Establish solo, small-gang, fleet, factional-warfare, war, low-security, null-security, or wormhole preference; desired engagement profile; fleet role; session length; experience; available support; and ship-and-pod loss budget. Ask no more than three focused questions, and skip questions already answered by the goal or constraints.",
    evidence:
      "Use get_character_context for location, ship, skills, wallet, and optionally skill queue. Inspect GetCharactersCharacterIdAssets for suitable owned and staged hulls, and GetCharactersCharacterIdKillmailsRecent for the pilot's recent losses when authorized and genuinely useful. Use factional-warfare, war, route, sovereignty, system-kill, and system-jump operations only when they match the chosen PvP context. Resolve candidate systems, compare routes, and price a replaceable hull and essential fit with bounded public-market evidence.",
    advice:
      "Recommend an engagement style, role, replaceable hull class and concrete skill-compatible candidate, staging point or search route, preparation list, and disengagement rules. Prefer already-owned staged ships when sensible; otherwise provide a bounded shopping list and public-market route. Explain how the recommendation matches the pilot's experience and loss budget, suggest a deliberately limited first roam or fleet, and make the first in-game action explicit.",
    limits:
      "ESI killmails and hourly system activity are delayed historical evidence, not live intelligence or a complete combat record. ESI does not expose local chat, directional scan, probes, fleets, gate camps, wormhole chains, current doctrines, or guaranteed targets. Never describe a system as safe, active now, or a certain source of fights; require live map, scout, corporation, fleet, and directional-scan checks.",
  },
};

export function renderActivityGuidance(activity: EveActivity): string {
  const guidance = ACTIVITY_GUIDANCE[activity];
  return [
    `Activity playbook: ${guidance.title}.`,
    `Clarify only material gaps: ${guidance.clarify}`,
    `Evidence workflow: ${guidance.evidence}`,
    `Turn evidence into advice: ${guidance.advice}`,
    `Limits and in-game checks: ${guidance.limits}`,
  ].join("\n");
}
