import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.deckfour.xes.classification.XEventAndClassifier;
import org.deckfour.xes.classification.XEventClassifier;
import org.deckfour.xes.classification.XEventLifeTransClassifier;
import org.deckfour.xes.classification.XEventNameClassifier;
import org.deckfour.xes.extension.std.XConceptExtension;
import org.deckfour.xes.factory.XFactoryNaiveImpl;
import org.deckfour.xes.in.XesXmlParser;
import org.deckfour.xes.model.XEvent;
import org.deckfour.xes.model.XLog;
import org.deckfour.xes.model.XTrace;
import org.processmining.framework.packages.PackageManager.Canceller;
import org.processmining.plugins.InductiveMiner.efficienttree.EfficientTree;
import org.processmining.plugins.inductiveminer2.logs.IMLog;
import org.processmining.plugins.inductiveminer2.mining.InductiveMiner;
import org.processmining.plugins.inductiveminer2.mining.MiningParametersAbstract;
import org.processmining.plugins.inductiveminer2.variants.MiningParametersIM;
import org.processmining.plugins.inductiveminer2.variants.MiningParametersIMInfrequent;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Headless behavioural oracle for ProM's Inductive Miner.
 *
 * Reads one JSON request per line on stdin, writes one JSON response per line
 * on stdout. Batching over stdin rather than one process per case keeps the
 * ~0.4 s JVM startup out of the differential loop; tens of thousands of cases
 * are the point.
 *
 * Request:  {"id":"x","traces":[["a","b"],[]],"variant":"IMf","noiseThreshold":0.2}
 * Response: {"id":"x","canonical":"...","raw":"..."}
 *        |  {"id":"x","error":"..."}
 *
 * Multithreading is switched off deliberately, not for speed: ProM's
 * "leave out one activity" fall-through races its candidates on a thread pool
 * and keeps whichever finishes first, so with the pool enabled the reference is
 * not reproducible against itself.
 */
public class OracleMain {

	public static void main(String[] args) throws Exception {
		if (args.length > 0 && "--xes".equals(args[0])) {
			xesMode(args);
			return;
		}
		BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
		PrintStream out = new PrintStream(System.out, true, "UTF-8");
		String line;
		while ((line = in.readLine()) != null) {
			line = line.trim();
			if (line.isEmpty()) {
				continue;
			}
			String id = "?";
			try {
				JsonObject req = new JsonParser().parse(line).getAsJsonObject();
				id = req.has("id") ? req.get("id").getAsString() : "?";
				out.println(handle(id, req).toString());
			} catch (Throwable t) {
				JsonObject err = new JsonObject();
				err.addProperty("id", id);
				err.addProperty("error", t.getClass().getSimpleName() + ": " + t.getMessage());
				out.println(err.toString());
			}
		}
	}

	/**
	 * Golden-log mode: mine a real XES file under a named event classifier.
	 *
	 *   OracleMain --xes log.xes --classifier name|name+lifecycle \
	 *              --variant IM|IMf --noise 0.2 [--dump traces.json]
	 *
	 * `--dump` writes the *classified* traces, which is what the Rust side then
	 * consumes. That split is deliberate: in Promenade the host applies the
	 * classifier (it redefines the log's activity column) and the plugin only
	 * ever sees event classes, so the comparison should start where the plugin
	 * starts. It also means the classifier itself is exercised by ProM's own
	 * implementation rather than by a reimplementation of it.
	 */
	private static void xesMode(String[] args) throws Exception {
		String path = null, classifierName = "name", variant = "IMf", dump = null;
		float noise = 0.0f;
		for (int i = 0; i < args.length - 1; i++) {
			if ("--xes".equals(args[i])) path = args[i + 1];
			else if ("--classifier".equals(args[i])) classifierName = args[i + 1];
			else if ("--variant".equals(args[i])) variant = args[i + 1];
			else if ("--noise".equals(args[i])) noise = Float.parseFloat(args[i + 1]);
			else if ("--dump".equals(args[i])) dump = args[i + 1];
		}

		XLog xLog = new XesXmlParser().parse(new java.io.File(path)).get(0);

		XEventClassifier classifier;
		if ("name+lifecycle".equals(classifierName)) {
			classifier = new XEventAndClassifier(new XEventNameClassifier(),
					new XEventLifeTransClassifier());
		} else {
			classifier = new XEventNameClassifier();
		}

		MiningParametersAbstract params = "IM".equalsIgnoreCase(variant)
				? new MiningParametersIM()
				: new MiningParametersIMInfrequent();
		params.setClassifier(classifier);
		params.setNoiseThreshold(noise);
		params.setUseMultithreading(false);
		params.setDebug(false);

		if (dump != null) {
			JsonArray traces = new JsonArray();
			for (XTrace trace : xLog) {
				JsonArray events = new JsonArray();
				for (XEvent event : trace) {
					events.add(new com.google.gson.JsonPrimitive(classifier.getClassIdentity(event)));
				}
				traces.add(events);
			}
			JsonObject req = new JsonObject();
			req.addProperty("id", "golden");
			req.add("traces", traces);
			req.addProperty("variant", variant);
			req.addProperty("noiseThreshold", noise);
			try (java.io.PrintStream ps = new java.io.PrintStream(dump, "UTF-8")) {
				ps.println(req.toString());
			}
		}

		IMLog imLog = params.getIMLog(xLog);
		EfficientTree tree = InductiveMiner.mineEfficientTree(imLog, params, new Canceller() {
			public boolean isCancelled() {
				return false;
			}
		});

		JsonObject res = new JsonObject();
		res.addProperty("id", "golden");
		if (tree == null) {
			res.addProperty("error", "miner returned null");
		} else {
			List<String> violations = new ArrayList<>();
			res.addProperty("canonical", render(tree, tree.getRoot(), true, violations));
			if (!violations.isEmpty()) {
				JsonArray v = new JsonArray();
				for (String s : violations) {
					v.add(new com.google.gson.JsonPrimitive(s));
				}
				res.add("violations", v);
			}
		}
		System.out.println(res.toString());
	}

	private static JsonObject handle(String id, JsonObject req) {
		XLog xLog = buildLog(req.getAsJsonArray("traces"));

		String variant = req.has("variant") ? req.get("variant").getAsString() : "IMf";
		float noise = req.has("noiseThreshold") ? req.get("noiseThreshold").getAsFloat() : 0.0f;

		MiningParametersAbstract params;
		if ("IM".equalsIgnoreCase(variant)) {
			params = new MiningParametersIM();
		} else if ("IMf".equalsIgnoreCase(variant)) {
			params = new MiningParametersIMInfrequent();
		} else {
			throw new IllegalArgumentException("unknown variant " + variant);
		}
		params.setNoiseThreshold(noise);
		params.setUseMultithreading(false);
		params.setDebug(false);

		IMLog imLog = params.getIMLog(xLog);
		EfficientTree tree = InductiveMiner.mineEfficientTree(imLog, params, new Canceller() {
			public boolean isCancelled() {
				return false;
			}
		});

		JsonObject res = new JsonObject();
		res.addProperty("id", id);
		if (tree == null) {
			res.addProperty("error", "miner returned null");
			return res;
		}
		List<String> violations = new ArrayList<>();
		res.addProperty("raw", render(tree, tree.getRoot(), false, violations));
		res.addProperty("canonical", render(tree, tree.getRoot(), true, violations));
		if (!violations.isEmpty()) {
			JsonArray v = new JsonArray();
			for (String s : violations) {
				v.add(new com.google.gson.JsonPrimitive(s));
			}
			res.add("violations", v);
		}
		return res;
	}

	/** An in-memory XLog carrying nothing but concept:name — no timestamps, no life cycle. */
	private static XLog buildLog(JsonArray traces) {
		XFactoryNaiveImpl factory = new XFactoryNaiveImpl();
		XLog log = factory.createLog();
		XConceptExtension concept = XConceptExtension.instance();
		int t = 0;
		for (JsonElement te : traces) {
			XTrace trace = factory.createTrace();
			concept.assignName(trace, "t" + t);
			for (JsonElement ee : te.getAsJsonArray()) {
				XEvent event = factory.createEvent();
				concept.assignName(event, ee.getAsString());
				trace.add(event);
			}
			log.add(trace);
			t++;
		}
		return log;
	}

	/**
	 * Renders a tree.
	 *
	 * `canonical` sorts the children of the commutative operators (xor,
	 * parallel) and of a loop's redo branches, so that an ordering ProM leaves
	 * to hash iteration order does not read as a behavioural difference. It
	 * never reorders a sequence, and never moves a loop's body out of first
	 * position — both of those carry meaning.
	 *
	 * The loop's third child is expected to be tau: ProM builds ternary loops
	 * `(body, redo, exit)` with a tau exit, and `↺(B,R,τ) ≡ ↺(B,R)`. If that
	 * ever fails to hold the case is flagged rather than quietly re-read.
	 */
	private static String render(EfficientTree tree, int node, boolean canonical, List<String> violations) {
		if (tree.isTau(node)) {
			return "tau";
		}
		if (tree.isActivity(node)) {
			return "'" + tree.getActivityName(node).replace("\\", "\\\\").replace("'", "\\'") + "'";
		}

		List<String> kids = new ArrayList<>();
		for (int child : tree.getChildren(node)) {
			kids.add(render(tree, child, canonical, violations));
		}

		String op;
		if (tree.isXor(node)) {
			op = "xor";
			if (canonical) {
				Collections.sort(kids);
			}
		} else if (tree.isSequence(node)) {
			op = "seq";
		} else if (tree.isConcurrent(node)) {
			op = "and";
			if (canonical) {
				Collections.sort(kids);
			}
		} else if (tree.isLoop(node)) {
			op = "loop";
			if (kids.size() != 3) {
				violations.add("loop with " + kids.size() + " children");
			} else {
				if (!"tau".equals(kids.get(2))) {
					violations.add("loop exit child is not tau: " + kids.get(2));
				} else {
					kids = kids.subList(0, 2);
				}
			}
		} else if (tree.isOr(node)) {
			op = "or";
			if (canonical) {
				Collections.sort(kids);
			}
		} else if (tree.isInterleaved(node)) {
			op = "int";
		} else {
			op = "unknown" + tree.getNodeType(node);
		}

		StringBuilder sb = new StringBuilder(op).append('(');
		for (int i = 0; i < kids.size(); i++) {
			if (i > 0) {
				sb.append(',');
			}
			sb.append(kids.get(i));
		}
		return sb.append(')').toString();
	}
}
