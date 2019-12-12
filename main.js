/*global WabtModule, fetch, WebAssembly */

// https://webassembly.org/getting-started/js-api/

function instantiate(bytes, imports) {
    return WebAssembly.compile(bytes)
        .then(m => new WebAssembly.Instance(m, imports));
}

let wabt = WabtModule();

fetch("minimal.wat")
    .then(response => response.text())
    .then(text => {
        let result = wabt.parseWat("foo", text);
        return result.toBinary({}).buffer;
    }).then(bytes => instantiate(bytes))
    .then(instance => {
        console.log(instance.exports.helloWorld());
    });
