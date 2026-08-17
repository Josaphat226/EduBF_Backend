const axios = require('axios')
const crypto = require('crypto')

const SEBPAY_API = 'https://newapi.sebpay.bj/api/v1'

function headers() {
  return {
    'X-Public-Key': process.env.SEBPAY_PUBLIC_KEY,
    'X-Secret-Key': process.env.SEBPAY_SECRET_KEY,
    'Content-Type': 'application/json',
  }
}

async function listerOperateurs(pays) {
  const url = pays ? `${SEBPAY_API}/operators?country=${pays}` : `${SEBPAY_API}/operators`
  try {
    const { data } = await axios.get(url, { headers: headers() })
    return data.data
  } catch (err) {
    console.error('Détail erreur SebPay:', JSON.stringify(err.response?.data))
    throw err
  }
}

async function creerCollecte({ montant, devise, telephone, operateur, pays, reference, callbackUrl, otpCode }) {
  const { data } = await axios.post(`${SEBPAY_API}/collections`, {
    amount: montant,
    currency: devise,
    phone: telephone,
    operator: operateur,
    country: pays,
    external_reference: reference,
    callback_url: callbackUrl,
    ...(otpCode ? { otp_code: otpCode } : {}),
  }, { headers: headers() })
  return data.data
}

async function verifierCollecte(idOuReference) {
  const { data } = await axios.get(`${SEBPAY_API}/collections/${idOuReference}`, { headers: headers() })
  return data.data
}

function verifierSignatureWebhook(corpsBrut, signatureRecue) {
  if (!signatureRecue) return false
  const signatureAttendue = crypto
    .createHmac('sha256', process.env.SEBPAY_SECRET_KEY)
    .update(corpsBrut)
    .digest('hex')

  const a = Buffer.from(signatureAttendue)
  const b = Buffer.from(signatureRecue)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

module.exports = { listerOperateurs, creerCollecte, verifierCollecte, verifierSignatureWebhook }