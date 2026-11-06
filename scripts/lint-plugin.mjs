export default {
  meta: { name: "local" },
  rules: {
    "no-let": {
      create(context) {
        return {
          VariableDeclaration(node) {
            if (node.kind === "let") {
              context.report({ node, message: "let を使わず const にしてください。" });
            }
          },
        };
      },
    },
  },
};
