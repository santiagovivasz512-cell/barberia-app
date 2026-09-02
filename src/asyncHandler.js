// Express 4 no atrapa errores de handlers async por si solo; esto reenvia
// cualquier rechazo de promesa a next(err) para que llegue al middleware de errores.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { asyncHandler };
