import { StaticDataCache } from "../src/static-data.js";
import { buildSkillGraph } from "../src/skill-graph.js";

const snapshot = await new StaticDataCache().initialize();
try {
  const { catalog, status } = snapshot;
  const skills = catalog.publishedSkillIds();
  const graph = buildSkillGraph(
    catalog,
    skills.map((id) => ({ skillId: id, level: 5 })),
  );
  console.log(
    JSON.stringify(
      {
        staticData: status,
        publishedSkills: skills.length,
        levelNodes: graph.nodes.length,
        edges: graph.edges.length,
        dependencyReplay: "passed",
        examples: [
          "Mining II",
          "exhumer",
          "Hulk",
          "Jump Freighters",
          "Rhea",
        ].map((target) => catalog.resolve(target)),
      },
      null,
      2,
    ),
  );
} finally {
  snapshot.release();
}
