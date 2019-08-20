const Morph = require('morphmorph')
const { createError, send } = require('micro')
const admin = require('firebase-admin')

// const crypto = require('crypto')
// function push(collection) {
//   const id = crypto.randomBytes(16).toString('hex')
//   const ref = collection.child(id)
//   return ref
//     .once('value')
//     .then(data => data.exists())
//     .then(exists => (exists ? push(collection) : ref))
// }

const PRIVATE_KEY = JSON.parse(Buffer.from(process.env.FIREBASE_PRIVATE_KEY, 'base64').toString())

const mapper = new Morph({
  types: {
    bool: v => {
      if (v == null) return undefined
      if (v === 'false') return false
      return Boolean(v)
    }
  }
})

const allowedKeys = [
  'backgroundColor',
  'backgroundImage',
  'code',
  { field: 'dropShadow', type: 'bool' },
  'dropShadowBlurRadius',
  'dropShadowOffsetY',
  'exportSize',
  'fontFamily',
  'fontSize',
  // 'fontUrl',
  'highlights',
  'language',
  'lineHeight',
  { field: 'lineNumbers', type: 'bool' },
  'marginHorizontal',
  'marginVertical',
  'paddingHorizontal',
  'paddingVertical',
  'preset',
  { field: 'squaredImage', type: 'bool' },
  'theme',
  'watermark',
  { field: 'widthAdjustment', type: 'bool' },
  { field: 'windowControls', type: 'bool' },
  'windowTheme'
]

function sanitizeInput(obj = {}) {
  return mapper.map(allowedKeys, obj)
}

function getSnippet(req) {
  const id = req.query.id

  if (!id) {
    throw createError(400, 'id is a required parameter')
  }

  let promise
  if (id.length > 30) {
    const db = admin.database()

    promise = db
      .ref('snippets')
      .child(id)
      .once('value')
      .then(data => {
        if (data.exists()) {
          return {
            ...data.val(),
            id
          }
        }
        return null
      })
  } else {
    const db = admin.firestore()

    promise = db
      .collection('snippets')
      .doc(id)
      .get()
      .then(data => {
        if (data.exists) {
          return {
            ...data.data(),
            id
          }
        }
        return null
      })
  }

  return promise.then(data => {
    if (data) {
      return data
    }

    const axios = require('axios')
    return axios
      .get(`https://api.github.com/gists/${id}`, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        }
      })
      .then(res => res.data)
      .then(({ files }) => {
        const filename = Object.keys(files)[0]
        const snippet = files[filename]

        return {
          id,
          code: snippet.content,
          language: snippet.language && snippet.language.toLowerCase()
        }
      })
      .catch(e => {
        throw createError(e.response.status, e.response.data.message)
      })
  })
}

async function createSnippet(user, req) {
  const data = req.body

  if (data.code == null) {
    throw createError(400, 'code is a required body parameter')
  }

  const db = admin.firestore()

  const collection = db.collection('snippets')
  const ref = collection.doc()

  return ref
    .create({
      ...sanitizeInput(data),
      createdAt: admin.firestore.Timestamp.now()._seconds,
      updatedAt: admin.firestore.Timestamp.now()._seconds,
      userId: user.uid
    })
    .then(() => ref.get())
    .then(snapshot => snapshot.data())
    .then(val => ({
      ...val,
      id: ref.id
    }))
}

async function updateSnippet(user, req) {
  const id = req.query.id && req.query.id.trim()

  if (!id) {
    throw createError(400, 'id is a required parameter')
  }

  const db = admin.firestore()
  const ref = db.collection('snippets').doc(id)

  await ref
    .get()
    .then(snapshot => snapshot.data())
    .then(value => {
      if (value.userId !== user.uid) {
        throw createError(403, 'Forbidden')
      }
      return value
    })

  const data = req.body

  if (!data) {
    // TODO must be DELETE
    return ref.delete().then(() => ({
      id: ref.id
    }))
  }

  if (typeof data !== 'object') {
    throw createError(400, 'Invalid request body')
  }

  return ref
    .update({ ...sanitizeInput(data), updatedAt: admin.firestore.Timestamp.now()._seconds })
    .then(() => ref.get())
    .then(snapshot => snapshot.data())
    .then(val => ({
      ...val,
      id: ref.id
    }))
}

function handleErrors(fn) {
  return async function(req, res) {
    try {
      return send(res, 200, await fn(req, res))
    } catch (err) {
      console.error(err)
      send(res, err.statusCode || 500, err.message || err)
    }
  }
}

async function authorizeUser(req) {
  const token = req.headers.authorization.split(/\s+/).pop()
  if (!token) throw createError(401, 'Unauthorized')
  const user = await admin.auth().verifyIdToken(token)
  if (!user) throw createError(401, 'Unauthorized')
  return user
}

module.exports = handleErrors(async function(req, res) {
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert(PRIVATE_KEY),
      databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
    })
  }

  switch (req.method) {
    case 'POST': {
      const user = await authorizeUser(req)
      return createSnippet(user, req, res)
    }
    // TODO make updateSnippet general to reuse
    case 'DELETE':
    case 'PATCH': {
      const user = await authorizeUser(req)
      return updateSnippet(user, req, res)
    }
    case 'GET':
      return getSnippet(req, res)
    default:
      throw createError(501, 'Not Implemented')
  }
})