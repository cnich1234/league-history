// Re-export so the CLI scripts and the serverless bundle share one mapping.
// A second copy would drift, and a wrong owner mapping silently attributes
// someone's bets and bankroll to the wrong person.
export { SLEEPER_OWNERS } from '../lib/sleeper-owners.js';
