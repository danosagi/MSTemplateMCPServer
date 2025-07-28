import express, { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const server = new McpServer({
  name: "mcp-streamable-http",
  version: "1.0.0",
});

// Get Chuck Norris joke tool
const getChuckJoke = server.tool(
  "get-chuck-joke",
  "Get a random Chuck Norris joke",
  async () => {
    const response = await fetch("https://api.chucknorris.io/jokes/random");
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.value,
        },
      ],
    };
  }
);

// Get Chuck Norris joke by category tool
const getChuckJokeByCategory = server.tool(
  "get-chuck-joke-by-category",
  "Get a random Chuck Norris joke by category",
  {
    category: z.string().describe("Category of the Chuck Norris joke"),
  },
  async (params: { category: string }) => {
    const response = await fetch(
      `https://api.chucknorris.io/jokes/random?category=${params.category}`
    );
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.value,
        },
      ],
    };
  }
);

// Get Chuck Norris joke categories tool
const getChuckCategories = server.tool(
  "get-chuck-categories",
  "Get all available categories for Chuck Norris jokes",
  async () => {
    const response = await fetch("https://api.chucknorris.io/jokes/categories");
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.join(", "),
        },
      ],
    };
  }
);

// Get Dad joke tool
const getDadJoke = server.tool(
  "get-dad-joke",
  "Get a random dad joke",
  async () => {
    const response = await fetch("https://icanhazdadjoke.com/", {
      headers: {
        Accept: "application/json",
      },
    });
    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: data.joke,
        },
      ],
    };
  }
);

// *** Validate US Address in USPS ***
const validateAddress = server.tool(
  "validate-address",
  "Validate a US address using the USPS API",
  {
    streetAddress: z.string().describe("The street address"),
    city: z.string().describe("The city"),
    state: z.string().describe("The 2-letter state code"),
    zipCode: z.string().optional().describe("The 5-digit ZIP code"),
  },
  async (params: { streetAddress: string; city: string; state: string; zipCode?: string }) => {
    try {
      // 1. Get Access Token from USPS
      const tokenResponse = await fetch("https://apis.usps.com/oauth2/v3/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: process.env.USPS_CLIENT_ID || "",
          client_secret: process.env.USPS_CLIENT_SECRET || "",
        }),
      });

      if (!tokenResponse.ok) {
        throw new Error("Failed to get USPS access token");
      }

      const tokenData = await tokenResponse.json();
      const accessToken = tokenData.access_token;

      // 2. Validate the Address
      const validationUrl = new URL("https://apis.usps.com/addresses/v3/address");
      validationUrl.searchParams.append("streetAddress", params.streetAddress);
      validationUrl.searchParams.append("city", params.city);
      validationUrl.searchParams.append("state", params.state);
      if(params.zipCode) {
        validationUrl.searchParams.append("ZIPCode", params.zipCode);
      }
      
      const validationResponse = await fetch(validationUrl.toString(), {
        method: "GET", // Changed to GET as per documentation for this endpoint
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      if (!validationResponse.ok) {
         const errorText = await validationResponse.text();
         console.error("USPS API Error:", errorText);
         throw new Error(`Failed to validate address with USPS API. Status: ${validationResponse.status}`);
      }
      
      const validationData = await validationResponse.json();
      
      // 3. Process the Response
      let feedback = "Address is invalid.";
      
      if (validationData.address) {
        const { DPVConfirmation } = validationData.additionalInfo || {};
        
        // Normalize for comparison
        const originalStreet = params.streetAddress.trim().toUpperCase();
        const returnedStreet = validationData.address.streetAddress.trim().toUpperCase();

        const suggestedAddress = `${validationData.address.streetAddress}, ${validationData.address.city}, ${validationData.address.state} ${validationData.address.ZIPCode}-${validationData.address.ZIPPlus4}`;

        // *** NEW LOGIC ***
        // If the API corrected the street, always provide it as a suggestion.
        if (originalStreet !== returnedStreet) {
             feedback = `Address was corrected. Suggested address: ${suggestedAddress}`;
        } else {
            // If the street is the same, check DPV codes.
            if (DPVConfirmation === 'Y') {
                feedback = "Address is valid.";
            } else if (DPVConfirmation === 'D' || DPVConfirmation === 'S') {
                // Address is valid but missing secondary info (e.g., apartment number)
                feedback = `Address could be more accurate. Suggested address: ${suggestedAddress}`;
            }
        }

      } else {
          // Handle cases where the API returns errors or no matches
          if(validationData.errors && validationData.errors.length > 0) {
              feedback = `Invalid Address. Reason: ${validationData.errors[0].text}`;
          }
      }

      return {
        content: [
          {
            type: "text",
            text: feedback,
          },
        ],
      };
    } catch (error: any) {
      console.error("Error in validateAddress tool:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error.message}`,
          },
        ],
      };
    }
  }
);


const app = express();
app.use(express.json());

const transport: StreamableHTTPServerTransport =
  new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // set to undefined for stateless servers
  });

// Setup routes for the server
const setupServer = async () => {
  await server.connect(transport);
};

app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP request:", req.body);
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.get("/mcp", async (req: Request, res: Response) => {
  console.log("Received GET MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

app.delete("/mcp", async (req: Request, res: Response) => {
  console.log("Received DELETE MCP request");
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    })
  );
});

// Start the server
const PORT = process.env.PORT || 3000;
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to set up the server:", error);
    process.exit(1);
  });
