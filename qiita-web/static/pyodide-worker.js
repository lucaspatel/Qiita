/**
 * Pyodide Web Worker
 * Runs Python code in a separate thread to avoid blocking the UI
 */

let pyodide = null;
let validationCode = null;

// Send message to main thread
const sendMessage = (type, payload) => {
  self.postMessage({ type, ...payload });
};

// Load validation code from server
const loadValidationCode = async () => {
  if (validationCode) return validationCode;
  const response = await fetch('/validation.py');
  validationCode = await response.text();
  return validationCode;
};

// Initialize Pyodide — config passed from main thread (single source of truth in config.ts)
const initializePyodide = async ({ cdnUrl, builtinPackages, micropipPackages }) => {
  try {
    sendMessage('progress', { state: 'loading-core', progress: 10 });

    // Import Pyodide
    importScripts(`${cdnUrl}pyodide.js`);
    sendMessage('progress', { state: 'loading-core', progress: 20 });

    // Load Pyodide
    pyodide = await loadPyodide({
      indexURL: cdnUrl,
    });
    sendMessage('progress', { state: 'loading-core', progress: 50 });

    // Load built-in packages
    sendMessage('progress', { state: 'installing-packages', progress: 50 });
    await pyodide.loadPackage(builtinPackages);
    sendMessage('progress', { state: 'installing-packages', progress: 70 });

    // Install micropip packages
    await pyodide.runPythonAsync('import micropip');

    for (let i = 0; i < micropipPackages.length; i++) {
      const pkg = micropipPackages[i];
      await pyodide.runPythonAsync(`await micropip.install("${pkg}")`);
      sendMessage('progress', {
        state: 'installing-packages',
        progress: 70 + ((i + 1) / micropipPackages.length) * 25
      });
    }

    sendMessage('progress', { state: 'ready', progress: 100 });
    sendMessage('initialized', { success: true });
  } catch (err) {
    sendMessage('error', { message: err.message || 'Failed to initialize Pyodide' });
  }
};

// Write file to Pyodide filesystem
const writeFileToPyodide = (filename, data) => {
  try {
    pyodide.FS.mkdir('/tmp');
  } catch {
    // Directory may already exist
  }

  if (data instanceof ArrayBuffer) {
    pyodide.FS.writeFile(`/tmp/${filename}`, new Uint8Array(data));
  } else if (typeof data === 'string') {
    pyodide.FS.writeFile(`/tmp/${filename}`, data);
  }
};

// Run validation
const runValidation = async (fileData, fileName, configYaml) => {
  if (!pyodide) {
    throw new Error('Pyodide not initialized');
  }

  let fileExt = '.' + (fileName.split('.').pop()?.toLowerCase() || 'csv');
  if (fileExt === '.tsv') fileExt = '.txt';
  const dataFilename = `data_${Date.now()}${fileExt}`;
  const configFilename = `config_${Date.now()}.yml`;

  try {
    // Write files to Pyodide filesystem
    writeFileToPyodide(dataFilename, fileData);
    writeFileToPyodide(configFilename, configYaml);

    // Load validation code
    const code = await loadValidationCode();
    await pyodide.runPythonAsync(code);

    // Run validation
    const resultProxy = await pyodide.runPythonAsync(
      `run_metameq_validation('/tmp/${dataFilename}', '/tmp/${configFilename}', '${fileExt}')`
    );

    // Convert Python dict to JS object
    const result = resultProxy.toJs({ dict_converter: Object.fromEntries });
    resultProxy.destroy();

    // Clean up temp files
    try {
      pyodide.FS.unlink(`/tmp/${dataFilename}`);
      pyodide.FS.unlink(`/tmp/${configFilename}`);
    } catch {
      // Ignore cleanup errors
    }

    // Convert nested Maps to objects
    const convertMaps = (obj) => {
      if (obj instanceof Map) {
        const converted = {};
        for (const [key, value] of obj) {
          converted[key] = convertMaps(value);
        }
        return converted;
      }
      if (Array.isArray(obj)) {
        return obj.map(convertMaps);
      }
      if (obj && typeof obj === 'object') {
        const converted = {};
        for (const [key, value] of Object.entries(obj)) {
          converted[key] = convertMaps(value);
        }
        return converted;
      }
      return obj;
    };

    return convertMaps(result);
  } catch (err) {
    // Try to clean up on error
    try {
      pyodide.FS.unlink(`/tmp/${dataFilename}`);
      pyodide.FS.unlink(`/tmp/${configFilename}`);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
};

// Handle messages from main thread
self.onmessage = async (event) => {
  const { type, id, ...data } = event.data;

  try {
    switch (type) {
      case 'init':
        await initializePyodide({
          cdnUrl: data.cdnUrl,
          builtinPackages: data.builtinPackages,
          micropipPackages: data.micropipPackages,
        });
        break;

      case 'validate':
        const result = await runValidation(data.fileData, data.fileName, data.configYaml);
        sendMessage('validation-result', { id, result });
        break;

      default:
        sendMessage('error', { id, message: `Unknown message type: ${type}` });
    }
  } catch (err) {
    sendMessage('error', { id, message: err.message || 'Worker error' });
  }
};
