import "dotenv/config";

/** HTTP port for the exporter service */
export const PORT = parseInt(process.env.PORT || "4003", 10);

