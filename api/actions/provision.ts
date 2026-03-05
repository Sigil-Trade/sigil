import type { VercelRequest, VercelResponse } from "@vercel/node";

const ACTIONS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, Content-Encoding, Accept-Encoding",
  "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
  "Content-Type": "application/json",
  "X-Action-Version": "2.1.3",
  "X-Blockchain-Ids": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

type TemplateName = "conservative" | "moderate" | "aggressive";

const TEMPLATE_META: Record<
  TemplateName,
  { label: string; description: string }
> = {
  conservative: {
    label: "Conservative",
    description: "$500/day, Jupiter only, no leverage",
  },
  moderate: {
    label: "Moderate",
    description: "$2,000/day, Jupiter + Orca + Raydium + Meteora, 2x leverage",
  },
  aggressive: {
    label: "Aggressive",
    description: "$10,000/day, all protocols, 5x leverage",
  },
};

function setCors(res: VercelResponse) {
  Object.entries(ACTIONS_CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
}

function handleGet(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  const url = new URL(req.url!, `https://${req.headers.host}`);
  const template =
    (url.searchParams.get("template") as TemplateName) || "conservative";
  const config = TEMPLATE_META[template] || TEMPLATE_META.conservative;
  const baseUrl = url.origin;

  res.status(200).json({
    type: "action",
    icon: `${baseUrl}/icon.png`,
    title: "Create Phalnx Vault",
    description: `Set up a policy-enforced agent vault. Template: ${config.label} — ${config.description}`,
    label: "Create Vault",
    links: {
      actions: [
        {
          label: `Conservative — $500/day`,
          href: `${baseUrl}/api/actions/provision?template=conservative`,
        },
        {
          label: `Moderate — $2,000/day`,
          href: `${baseUrl}/api/actions/provision?template=moderate`,
        },
        {
          label: `Aggressive — $10,000/day`,
          href: `${baseUrl}/api/actions/provision?template=aggressive`,
        },
      ],
    },
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse) {
  setCors(res);

  try {
    const { PublicKey } = await import("@solana/web3.js");
    const { buildProvisionTransaction } =
      await import("../../apps/actions-server/src/lib/build-tx");
    const { TEMPLATES } =
      await import("../../apps/actions-server/src/lib/templates");

    const body = req.body as { account?: string };

    if (!body?.account) {
      return res
        .status(400)
        .json({ error: "Missing 'account' in request body" });
    }

    let owner: InstanceType<typeof PublicKey>;
    try {
      owner = new PublicKey(body.account);
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid 'account': not a valid public key" });
    }

    const url = new URL(req.url!, `https://${req.headers.host}`);
    const template =
      (url.searchParams.get("template") as TemplateName) || "conservative";
    if (!TEMPLATES[template]) {
      return res.status(400).json({ error: `Invalid template: ${template}` });
    }

    const dailyCapStr = url.searchParams.get("dailyCap");
    const dailyCap = dailyCapStr ? parseInt(dailyCapStr, 10) : undefined;
    if (dailyCap !== undefined && (isNaN(dailyCap) || dailyCap <= 0)) {
      return res
        .status(400)
        .json({ error: "Invalid dailyCap: must be a positive number" });
    }

    const agentPubkeyStr = url.searchParams.get("agentPubkey");
    if (!agentPubkeyStr) {
      return res
        .status(400)
        .json({ error: "Missing 'agentPubkey' query parameter" });
    }

    let agentPubkey: InstanceType<typeof PublicKey>;
    try {
      agentPubkey = new PublicKey(agentPubkeyStr);
    } catch {
      return res
        .status(400)
        .json({ error: "Invalid 'agentPubkey': not a valid public key" });
    }

    const vaultIdStr = url.searchParams.get("vaultId");
    const vaultId = vaultIdStr ? parseInt(vaultIdStr, 10) : 0;

    const { transaction, vaultAddress } = await buildProvisionTransaction({
      owner,
      agentPubkey,
      template,
      dailyCap,
      vaultId,
    });

    const serialized = Buffer.from(transaction.serialize()).toString("base64");
    const config = TEMPLATE_META[template];

    return res.status(200).json({
      transaction: serialized,
      message: `Vault created at ${vaultAddress}. Template: ${config.label} — ${config.description}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    setCors(res);
    return res.status(200).end();
  }

  if (req.method === "GET") {
    return handleGet(req, res);
  }

  if (req.method === "POST") {
    return handlePost(req, res);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
