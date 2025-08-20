import QRCode from "qrcode";

const text = process.argv[2] || "https://example.com/wedding-cake";
await QRCode.toFile("test-qr.png", text);
console.log("Wrote test-qr.png for:", text);
