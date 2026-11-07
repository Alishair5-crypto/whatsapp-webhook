"use strict";

const axios = require("axios");
const FormData = require("form-data");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const PDF_WIDTH = 500;
const PDF_HEIGHT = 650;

function sendJson(res, status, payload) {
  return res.status(status).json(payload);
}

function cleanText(value, field, maxLength) {
  if (typeof value !== "string") {
    throw new Error(field + " must be a string.");
  }
  const cleaned = value.trim();
  if (!cleaned) throw new Error(field + " is required.");
  if (cleaned.length > maxLength) {
    throw new Error(field + " must be " + maxLength + " characters or fewer.");
  }
  return cleaned;
}

function normalizePakistanPhone(value) {
  if (typeof value !== "string") throw new Error("to must be a phone number string.");
  const raw = value.trim();
  const digits = raw.replace(/[\s()+.-]/g, "");
  let normalized = digits;
  if (/^03\d{9}$/.test(digits)) normalized = "92" + digits.slice(1);
  if (!/^92\d{10}$/.test(normalized)) {
    throw new Error("to must be a Pakistani mobile number: 03xxxxxxxxx or 92xxxxxxxxxx.");
  }
  return normalized;
}

function formatAmount(value) {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error("total must be a finite number greater than or equal to 0.");
  }
  return new Intl.NumberFormat("en-PK", {
    maximumFractionDigits: 2
  }).format(amount);
}

async function createBillPdf(details) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PDF_WIDTH, PDF_HEIGHT]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const green = rgb(0.08, 0.42, 0.24);

  const title = "FATIMA ARTS - BILL";
  const titleWidth = bold.widthOfTextAtSize(title, 22);
  page.drawText(title, {
    x: (PDF_WIDTH - titleWidth) / 2,
    y: 590,
    size: 22,
    font: bold,
    color: green
  });

  const rows = [
    ["Customer Name", details.customerName],
    ["Product", details.product],
    ["Quantity", String(details.quantity)],
    ["Address", details.address],
    ["Total", "PKR " + details.total]
  ];

  let y = 525;
  for (const [label, value] of rows) {
    const labelText = label + ":";
    page.drawText(labelText, {
      x: 45, y, size: 12, font: bold, color: rgb(0.12, 0.12, 0.12)
    });

    const words = value.split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (regular.widthOfTextAtSize(candidate, 12) > 390) {
        if (!line) throw new Error(label + " contains a word too long for the bill.");
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
    if (lines.length > 5) throw new Error(label + " is too long to fit on the bill.");

    for (let i = 0; i < lines.length; i += 1) {
      page.drawText(lines[i], {
        x: 145, y: y - (i * 17), size: 12, font: regular, color: rgb(0.1, 0.1, 0.1)
      });
    }
    y -= Math.max(34, lines.length * 17 + 17);
  }

  const footer = "Shukriya! - Fatima Arts, Faisalabad";
  const footerWidth = regular.widthOfTextAtSize(footer, 10);
  page.drawText(footer, {
    x: (PDF_WIDTH - footerWidth) / 2,
    y: 35,
    size: 10,
    font: regular,
    color: rgb(0.25, 0.25, 0.25)
  });

  return Buffer.from(await pdf.save());
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { success: false, error: "Method not allowed. Use POST." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const to = normalizePakistanPhone(body.to);
    const customerName = cleanText(body.customerName, "customerName", 100);
    const product = cleanText(body.product, "product", 160);
    const address = cleanText(body.address, "address", 240);

    const quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new Error("quantity must be a whole number between 1 and 9999.");
    }
    const total = formatAmount(body.total);

    const token = process.env.WHATSAPP_TOKEN;
    const phoneNumberId = process.env.PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      console.error("[SEND-BILL] Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID environment variable.");
      return sendJson(res, 500, { success: false, error: "WhatsApp bill service is not configured." });
    }

    const pdfBuffer = await createBillPdf({ customerName, product, quantity, address, total });
    const form = new FormData();
    form.append("file", pdfBuffer, {
      filename: "Fatima-Arts-Bill.pdf",
      contentType: "application/pdf"
    });
    form.append("type", "application/pdf");
    form.append("messaging_product", "whatsapp");

    const headers = {
      ...form.getHeaders(),
      Authorization: "Bearer " + token
    };

    const uploadResponse = await axios.post(
      GRAPH_BASE + "/" + encodeURIComponent(phoneNumberId) + "/media",
      form,
      { headers, timeout: 30000, maxBodyLength: 10 * 1024 * 1024 }
    );
    const mediaId = uploadResponse.data && uploadResponse.data.id;
    if (!mediaId) throw new Error("WhatsApp media upload did not return a media ID.");

    const messageResponse = await axios.post(
      GRAPH_BASE + "/" + encodeURIComponent(phoneNumberId) + "/messages",
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "document",
        document: {
          id: mediaId,
          filename: "Fatima-Arts-Bill.pdf"
        }
      },
      {
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    return sendJson(res, 200, {
      success: true,
      message: "Bill sent successfully.",
      messageId: messageResponse.data && messageResponse.data.messages &&
        messageResponse.data.messages[0] && messageResponse.data.messages[0].id
    });
  } catch (err) {
    if (err.response) {
      console.error("[SEND-BILL] WhatsApp API error:", {
        status: err.response.status,
        data: err.response.data
      });
      return sendJson(res, 500, {
        success: false,
        error: (err.response.data && err.response.data.error &&
          err.response.data.error.message) || "WhatsApp API request failed."
      });
    }

    const isValidationError = !err.isAxiosError &&
      (err instanceof SyntaxError || /must be|required|too long|contains a word/i.test(err.message || ""));
    console.error("[SEND-BILL] Request failed:", err.message || "Unknown error");
    return sendJson(res, isValidationError ? 400 : 500, {
      success: false,
      error: isValidationError ? err.message : "Unable to generate or send the bill."
    });
  }
};
