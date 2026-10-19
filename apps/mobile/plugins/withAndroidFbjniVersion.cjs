const { withProjectBuildGradle } = require("expo/config-plugins");

// react-native-shiki-engine's fbjni:+ can resolve to NDK 28 builds incompatible with RN's
// NDK 27.1 libc++, crashing before JS with __cxa_init_primary_exception missing.
// Keep this equal to fbjni in react-native/gradle/libs.versions.toml.
const FBJNI_VERSION = "0.7.0";
const MARKER = "withAndroidFbjniVersion";

const BLOCKS = {
  groovy: `
// Added by ${MARKER}: keep fbjni on the version React Native ships against.
allprojects {
  configurations.all {
    resolutionStrategy.force 'com.facebook.fbjni:fbjni:${FBJNI_VERSION}'
  }
}
`,
  kt: `
// Added by ${MARKER}: keep fbjni on the version React Native ships against.
allprojects {
  configurations.all {
    resolutionStrategy.force("com.facebook.fbjni:fbjni:${FBJNI_VERSION}")
  }
}
`,
};

module.exports = function withAndroidFbjniVersion(config) {
  return withProjectBuildGradle(config, (nextConfig) => {
    const { contents, language } = nextConfig.modResults;
    const block = BLOCKS[language];
    if (block === undefined) {
      throw new Error(`${MARKER}: unsupported root build.gradle language "${language}".`);
    }
    if (!contents.includes(MARKER)) {
      nextConfig.modResults.contents = `${contents.trimEnd()}\n${block}`;
    }
    return nextConfig;
  });
};
