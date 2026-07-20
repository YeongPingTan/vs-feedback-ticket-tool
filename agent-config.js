// Agent configuration

module.exports = {
  // Copilot SDK — uses your existing GitHub Copilot subscription (no keys needed!)
  // Change model with: set COPILOT_MODEL=claude-sonnet-5
  copilot: {
    model: process.env.COPILOT_MODEL || 'gpt-5.4-mini',
  },

  // Azure DevOps
  ado: {
    organization: process.env.ADO_ORG || 'devdiv',
    project: process.env.ADO_PROJECT || 'DevDiv',
    baseUrl: process.env.ADO_BASE_URL || 'https://devdiv.visualstudio.com',
    // Token is fetched dynamically via `az account get-access-token`
    // Or set ADO_PAT for a personal access token
    pat: process.env.ADO_PAT || '',
  },

  // Server
  server: {
    port: parseInt(process.env.PORT || '3001', 10),
  },

  // Database
  db: {
    path: process.env.DB_PATH || './data/agent.db',
  },
};
