const expectedNodeVersion = "v24.10.0";

console.log("ServiceFlow runtime verification");
console.log("--------------------------------");
console.log(`Node.js:      ${process.version}`);
console.log(`Platform:     ${process.platform}`);
console.log(`Architecture: ${process.arch}`);

if (process.version !== expectedNodeVersion) {
  console.error(
    `\nRuntime verification FAILED: expected ${expectedNodeVersion}.`,
  );
  process.exitCode = 1;
} else {
  console.log("\nRuntime verification PASSED.");
}
