'use strict'

const {log, BaseKonnector, saveBills, request, retry} = require('cozy-konnector-libs')
const moment = require('moment')
let rq = request({
  // debug: true
})

// The goal of this connector is to fetch bills from the
// service trainline.fr
module.exports = new BaseKonnector(function fetch (fields) {
  return login(fields)
  .then(data => retry(fetchBills, {
    interval: 3000,
    throw_original: true,
    args: [data]
  }))
  .then(entries => saveBills(entries, fields.folderPath, {
    timeout: Date.now() + 60 * 1000,
    identifiers: 'trainline'
  }))
  .catch(err => {
    log('error', err.message, 'trainline connector error')
    console.log(err, 'trainline connector error')
  })
})

const baseUrl = 'https://www.captaintrain.com/'

function login (fields) {
  // Signin form
  const signinForm = {
    concur_auth_code: null,
    concur_migration_type: null,
    concur_new_email: null,
    correlation_key: null,
    email: fields.login,
    facebook_id: null,
    facebook_token: null,
    google_code: null,
    google_id: null,
    password: fields.password,
    source: null,
    user_itokend: null
  }
  // Signin
  const signinPath = `${baseUrl}api/v5/account/signin`
  return rq({
    uri: signinPath,
    method: 'POST',
    form: signinForm,
    resolveWithFullResponse: true
  })
  .then(res => {
    log('info', 'Connected')
    if (res.statusCode === 422) {
      throw new Error('LOGIN_FAILED')
    }
    // Retrieve token
    const token = res.body.meta.token

    rq = rq.defaults({
      headers: {
        Authorization: `Token token="${token}"`
      }
    })

    // the api/v5/pnrs uri gives all information necessary to get bill
    // information
    return rq(`${baseUrl}api/v5/pnrs`)
    .then(body => {
      const data = {}
      // We check there are bills
      if (body.proofs && body.proofs.length > 0) {
        saveMetadata(data, body)
        return getNextMetaData(computeNextDate(body.pnrs), data)
      } else {
        return data
      }
    })
  })
}

function computeNextDate (pnrs) {
  // To get new bills, it is necessary to get api/v5/pnrs?date=YYYY-MM-DD
  // This function computes the date YYYY-MM-DD
  // YYYY-MM-DD :
  //    - DD: always 1
  //    - MM: month before the month of the youngest received pnr
  //    - YY: year of the first month before the youngest received pnr

  // Indentify the minimum date in the pnr list
  const minDate = pnrs.reduce(
    (min, pnr) => Math.min(+min, +new Date(pnr.sort_date)), Infinity
  )
  return moment(minDate).subtract(1, 'month').set('date', 1)
                        .format('YYYY-MM-DD')
}

function getNextMetaData (startdate, data) {
  return rq(`${baseUrl}api/v5/pnrs?date=${startdate}`)
  .then(body => {
    if (body.proofs && body.proofs.length > 0) {
      saveMetadata(data, body)
      return getNextMetaData(computeNextDate(body.pnrs), data)
    } else {
      return data
    }
  })
}

function saveMetadata (data, body) {
  // Body structure received for api/v5/pnrs (with or without date parameter)
  //
  // body.pnrs (table of pnr):
  //  - id: unique identifier
  //  - sort_date: creation date
  //  - system: payment system, defines the label of operation. Default is sncf.
  //  - after_sales_log_ids: list of ids of related refunds
  //  - proof_ids: list of ids of related bills
  //  - cent: amount in cents
  //
  // body.proofs (table of bills):
  //  - id: unique identifier
  //  - url: url of the bill
  //  - created_at: creation date of the bill
  //  - type: type of operation ('purchase' or 'refund')
  //
  // body.after_sales_logs (table of refunds):
  //  - id: unique identifier
  //  - added_cents: extr expense for the refund
  //  - refunded_cents: amount of reinbursment
  //  - penalty_cents: amount penalty
  //  - date
  //
  if (typeof data.proofs === 'undefined') {
    data.proofs = []
  }
  data.proofs = data.proofs.concat(body.proofs)

  if (typeof data.pnrs === 'undefined') {
    data.pnrs = []
  }
  data.pnrs = data.pnrs.concat(body.pnrs)

  if (typeof data.folders === 'undefined') {
    data.folders = []
  }
  data.folders = data.folders.concat(body.folders)

  if (typeof data.after_sales_logs === 'undefined') {
    data.after_sales_logs = []
  }
  data.after_sales_logs = data.after_sales_logs.concat(body.after_sales_logs)
}

function fetchBills (data) {
  const bills = []
  // List of already managed proofs
  const managedProofId = []
  for (const proof of data.proofs) {
    if (!proof.url) {
      // No need to go further.
      continue
    }

    // The proof can be duplicated, we only manage the one which were not taken
    // care of already.
    if (managedProofId.indexOf(proof.id) !== -1) {
      // This proof is already dealt with
      continue
    } else {
      // Add to the managed proof list
      managedProofId.push(proof.id)
    }

    // A bill can be linked to several pnrs, we retrieve all of them
    // For some unknown reason, some users don't have pnrs backlinked to
    // proofs, let's initialize the array with the one linked to the proof.
    let linkedPNR = [data.pnrs.find(pnr => pnr.id === proof.pnr_id)]
    try {
      linkedPNR = data.pnrs.filter(
        pnr => pnr.proof_ids instanceof Array && pnr.proof_ids.indexOf(proof.id) !== -1
      )
    } catch (e) {
      // We do nothing with the error as linkedPNR is set anyway.
      log('warning', 'linkedPNR')
      console.log(e, 'linkedPNR error')
      log('warning', e)
    }

    // For some unknown reason, some users don't have system set for the pnr.
    // By default we set it to sncf
    linkedPNR = linkedPNR.map((pnr) => {
      if (typeof pnr.system === 'undefined') {
        pnr.system = 'sncf'
      }
      return pnr
    })

    // We try to find the list of the systems. there will be one
    // bankoperation/proof/system
    const systems = linkedPNR.reduce((sys, pnr) => {
      if (sys.indexOf(pnr.system) === -1) {
        return sys.concat(pnr.system)
      }
      return sys
    }, [])

    // Calculate the amount of each system because their is one operation per
    // system.
    for (const system of systems) {
      const bill = {
        pdfurl: proof.url,
        type: 'train',
        vendor: 'Trainline',
        system,
        date: moment(proof.created_at).hours(0)
                                      .minutes(0)
                                      .seconds(0)
                                      .milliseconds(0)
      }

      // Get the list of refunds for the current bill
      let refundID = []
      refundID = linkedPNR.filter(pnr => pnr.system === system).reduce(
        (list, pnr) => list.concat(pnr.after_sales_log_ids), []
      )
      let listRefund = []
      listRefund = refundID.reduce((list, id) => list.concat(
        data.after_sales_logs.find(asl => asl.id === id)), []
      )

      if (proof.type === 'purchase') {
        // Compute the sum of refunds for the current bill
        const reinboursedAmount = listRefund.reduce(
          (sum, rb) => sum - rb.added_cents + rb.refunded_cents, 0
        )
        // We compute the amount of not reimbursed trips.
        const paidAmount =
          linkedPNR.filter(pnr => pnr.system === system).reduce(
            (sum, p) => sum + p.cents, 0
          )
        // Get the the sum of penalties
        const penaltiesAmount = listRefund.reduce(
          (sum, rb) => sum + rb.penalty_cents, 0)
        bill.amount = (paidAmount + reinboursedAmount + penaltiesAmount) / 100
      } else {
        // Find the unique Refund based on the emission date
        const refund = listRefund.find(
          refund => refund.date === proof.created_at
        )
        bill.amount = (refund.refunded_cents - refund.added_cents) / 100
        bill.isRefund = true
      }

      bills.push(bill)
    }
  }

  const filteredBills = []
  // Recombine the bill list so that each entry.url is unique
  for (const bill of bills) {
    // Ensure the bill is not already in the list.
    const sameUrlBills = filteredBills.filter(b =>
        (b.pdfurl === bill.pdfurl && b.system === bill.system))
    if (sameUrlBills.length === 0) {
      const sameBill = bills.filter(b => (b.pdfurl === bill.pdfurl))
                            .filter(b => (b.system === bill.system))
      const newBill = {
        amount: sameBill.reduce((amount, b) => (amount + b.amount), 0),
        fileurl: bill.pdfurl,
        date: bill.date.toDate(),
        type: 'transport',
        vendor: 'Trainline',
        filename: getFileName(bill.date)
      }
      if (typeof bill.isRefund !== 'undefined') {
        newBill.isRefund = bill.isRefund
      }
      filteredBills.push(newBill)
    }
  }

  filteredBills.sort((a, b) => a.date < b.date ? 1 : -1)

  return filteredBills
}

function getFileName (date) {
  return `${date.format('YYYY_MM')}_Trainline.pdf`
}
