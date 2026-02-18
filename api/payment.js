import https from 'https';

// Decode base64 certificates from env vars
function getSSLAgent() {
  const cert = Buffer.from(process.env.AZUL_CERT_B64, 'base64').toString('utf-8');
  const key = Buffer.from(process.env.AZUL_PRIVATE_KEY_B64, 'base64').toString('utf-8');

  return new https.Agent({
    cert,
    key,
    rejectUnauthorized: true
  });
}

// Call Azul API using native https.request (fetch doesn't support mTLS agent)
function callAzul(url, headers, body, agent) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      agent,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Azul API base URL
function getBaseUrl() {
  const isDev = process.env.AZUL_ENV === 'development';
  return isDev
    ? 'https://pruebas.azul.com.do/WebServices/JSON/default.aspx'
    : 'https://pagos.azul.com.do/WebServices/JSON/default.aspx';
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const {
      cardNumber,
      expiration,
      cvc,
      amount,
      itbis,
      customOrderId,
      customerName,
      customerPhone
    } = req.body;

    // Validate required fields
    if (!cardNumber || !expiration || !cvc || !amount) {
      return res.status(400).json({ error: 'Missing required fields: cardNumber, expiration, cvc, amount' });
    }

    // Build Azul request
    const azulRequest = {
      Channel: "EC",
      Store: process.env.AZUL_MERCHANT_ID,
      CardNumber: cardNumber.replace(/\s/g, ''),
      Expiration: expiration,
      CVC: cvc,
      PosInputMode: "E-Commerce",
      TrxType: "Sale",
      Amount: String(amount),
      Itbis: String(itbis || "000"),
      CurrencyPosCode: "$",
      Payments: "1",
      Plan: "0",
      AcquirerRefData: "1",
      RRN: null,
      CustomerServicePhone: "",
      OrderNumber: "",
      ECommerceUrl: "https://pincerweb.com",
      CustomOrderId: customOrderId || "",
      DataVaultToken: "",
      SaveToDataVault: "0",
      ForceNo3DS: "1",
      AltMerchantName: ""
    };

    // Call Azul API with mTLS
    const agent = getSSLAgent();

    const result = await callAzul(
      getBaseUrl(),
      {
        'Auth1': process.env.AZUL_AUTH1,
        'Auth2': process.env.AZUL_AUTH2,
      },
      azulRequest,
      agent
    );

    // Check response
    if (result.IsoCode === '00') {
      // Payment approved
      return res.status(200).json({
        success: true,
        approved: true,
        authorizationCode: result.AuthorizationCode,
        azulOrderId: result.AzulOrderId,
        customOrderId: result.CustomOrderId,
        message: result.ResponseMessage,
        rrn: result.RRN,
        ticket: result.Ticket,
      });
    } else if (result.ResponseCode === 'Error') {
      // System error
      return res.status(200).json({
        success: false,
        approved: false,
        error: result.ErrorDescription,
        message: 'Error del sistema',
      });
    } else {
      // Declined
      return res.status(200).json({
        success: false,
        approved: false,
        isoCode: result.IsoCode,
        message: result.ResponseMessage || 'Tarjeta declinada',
      });
    }

  } catch (error) {
    console.error('payment error:', error);
    return res.status(500).json({ error: error.message });
  }
}
