let _log = console // fallback to console until init'd

const Logger = {
  init(outputChannel) { _log = outputChannel },
  info:  (...a) => _log.info(...a),
  warn:  (...a) => _log.warn(...a),
  error: (...a) => _log.error(...a),
}

module.exports = Logger
