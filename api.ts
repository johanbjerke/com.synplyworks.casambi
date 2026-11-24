// Homey app Web API. GET /api/app/com.synplyworks.casambi/health
// Requires an authenticated Homey session or API key (not public).
module.exports = {
  async getHealth({ homey }: { homey: any }) {
    return homey.app.getHealth();
  },
};
