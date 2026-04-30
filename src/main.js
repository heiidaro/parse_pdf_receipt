import { Client, Storage } from "node-appwrite";
import pdf from "pdf-parse";

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractAmount(rawText) {
  const text = String(rawText || "").replace(/\u00A0/g, " ");

  const priorityPatterns = [
    /(?:итого|итог|к оплате|сумма|оплачено|всего)\s*[:\-]?\s*([\d\s]+[,.]\d{1,2}|\d+)/i,
    /([\d\s]+[,.]\d{1,2})\s*(?:₽|руб|р\.|р)/i,
  ];

  for (const pattern of priorityPatterns) {
    const match = text.match(pattern);

    if (match?.[1]) {
      const normalized = match[1]
        .replace(/\s/g, "")
        .replace(",", ".")
        .replace(/[^\d.]/g, "");

      const amount = Number(normalized);

      if (!Number.isNaN(amount) && amount > 0) {
        return amount;
      }
    }
  }

  return 0;
}

function extractDate(rawText) {
  const text = String(rawText || "").replace(/\u00A0/g, " ");

  const ruDateMatch = text.match(
    /(\d{2})[./-](\d{2})[./-](\d{4})(?:\s*[|,]?\s*(\d{2}):(\d{2}))?/
  );

  if (ruDateMatch) {
    const [, day, month, year, hour = "12", minute = "00"] = ruDateMatch;

    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0
    ).toISOString();
  }

  const isoDateMatch = text.match(
    /(\d{4})[./-](\d{2})[./-](\d{2})(?:\s*[|,]?\s*(\d{2}):(\d{2}))?/
  );

  if (isoDateMatch) {
    const [, year, month, day, hour = "12", minute = "00"] = isoDateMatch;

    return new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      0,
      0
    ).toISOString();
  }

  return new Date().toISOString();
}

function extractMerchantName(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const placeLine = lines.find((line) =>
    line.toLowerCase().includes("место расчетов")
  );

  if (placeLine) {
    const afterDash = placeLine.split("-").pop()?.trim();

    if (afterDash && afterDash.length >= 3) {
      return afterDash;
    }

    return placeLine.replace(/место расчетов/i, "").trim() || "Электронный чек";
  }

  const badWords = [
    "кассовый чек",
    "чек",
    "итого",
    "итог",
    "сумма",
    "оплата",
    "наличными",
    "безналичными",
    "дата",
    "время",
    "фн",
    "фд",
    "фп",
    "инн",
    "ндс",
    "сайт",
    "телефон",
    "эл. адрес",
  ];

  const merchantLine = lines.find((line) => {
    const lower = line.toLowerCase();

    if (line.length < 3) return false;

    return !badWords.some((word) => lower.includes(word));
  });

  return merchantLine || "Электронный чек";
}

function extractReceiptItems(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const items = [];

  for (const line of lines) {
    const match = line.match(/^\d+\.\s+(.+)/);

    if (!match?.[1]) {
      continue;
    }

    const itemName = match[1]
      .replace(/\s+/g, " ")
      .replace(/Цена\s*\*\s*Кол.*$/i, "")
      .trim();

    if (itemName.length >= 2) {
      items.push(itemName);
    }
  }

  return items;
}

function buildReceiptNote(merchantName, items) {
  const shopName = merchantName || "Электронный чек";

  if (!items.length) {
    return shopName;
  }

  return `${shopName}\n\nТовары:\n${items
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n")}`;
}

function parseReceiptText(rawText) {
  const normalizedText = normalizeText(rawText);

  if (!normalizedText) {
    throw new Error("PDF распознан, но текст чека пустой");
  }

  const amount = extractAmount(rawText);

  if (!amount || amount <= 0) {
    throw new Error("Не удалось определить сумму из PDF-чека");
  }

  const date = extractDate(rawText);
  const merchantName = extractMerchantName(rawText);
  const items = extractReceiptItems(rawText);
  const note = buildReceiptNote(merchantName, items);
  
  return {
    rawText,
    amount,
    date,
    merchantName,
    items,
    note,
  };
}

function toBuffer(fileData) {
  if (Buffer.isBuffer(fileData)) {
    return fileData;
  }

  if (fileData instanceof ArrayBuffer) {
    return Buffer.from(fileData);
  }

  if (fileData?.buffer instanceof ArrayBuffer) {
    return Buffer.from(fileData.buffer);
  }

  return Buffer.from(fileData);
}

export default async ({ req, res, log, error }) => {
  try {
    const body =
      typeof req.bodyJson === "object" && req.bodyJson
        ? req.bodyJson
        : JSON.parse(req.body || "{}");

    const fileId = body.fileId;
    const bucketId = body.bucketId || "698ded11003046f79899";

    if (!fileId) {
      return res.json(
        {
          success: false,
          message: "Не передан fileId PDF-чека",
        },
        400
      );
    }

    const client = new Client()
      .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
      .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
      .setKey(req.headers["x-appwrite-key"] || "");

    const storage = new Storage(client);

    log(`Downloading PDF file: ${fileId}`);

    const fileData = await storage.getFileDownload({
      bucketId,
      fileId,
    });

    const buffer = toBuffer(fileData);

    log(`PDF size: ${buffer.length} bytes`);

    const pdfData = await pdf(buffer);
    const rawText = pdfData.text || "";

    const parsed = parseReceiptText(rawText);

    log(`Parsed receipt: ${parsed.merchantName}, ${parsed.amount}`);

    return res.json({
      success: true,
      ...parsed,
    });
  } catch (err) {
    error(err?.message || String(err));

    return res.json(
      {
        success: false,
        message: err?.message || "Не удалось распознать PDF-чек",
      },
      500
    );
  }
};
