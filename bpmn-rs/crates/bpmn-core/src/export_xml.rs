//! `Bpmn` -> plain BPMN 2.0 XML, with no `bpmndi:BPMNDiagram` section.
//!
//! This is the host-level export (the artifact tree's "Export" submenu,
//! `run.promenade.bpmn.export-xml`): it runs with no view open, so there is
//! no ELK-computed layout to write shape/edge bounds from. A `<process>`
//! with no diagram interchange section is still fully spec-valid BPMN
//! 2.0 XML -- most tools render it with their own auto-layout. Diagram
//! coordinates only ever exist client-side, inside the view, after layout
//! runs, so this export never includes them at all.

use crate::Bpmn;

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

const MODEL_NS: &str = "http://www.omg.org/spec/BPMN/20100524/MODEL";

fn element_tag(kind: crate::NodeKind) -> &'static str {
    use crate::NodeKind::*;
    match kind {
        Task => "task",
        StartEvent => "startEvent",
        EndEvent => "endEvent",
        ExclusiveGateway => "exclusiveGateway",
        ParallelGateway => "parallelGateway",
        InclusiveGateway => "inclusiveGateway",
    }
}

pub fn export_bpmn_xml(bpmn: &Bpmn, process_id: &str) -> String {
    let mut out = String::new();
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(&format!(
        "<definitions xmlns=\"{MODEL_NS}\" id=\"Definitions_1\" targetNamespace=\"http://promenade.local/bpmn\">\n"
    ));
    out.push_str(&format!("  <process id=\"{}\" isExecutable=\"false\">\n", xml_escape(process_id)));

    for n in &bpmn.nodes {
        let tag = element_tag(n.kind);
        let name_attr = n.label.as_deref().map(|l| format!(" name=\"{}\"", xml_escape(l))).unwrap_or_default();
        let incoming: Vec<&str> = bpmn.flows.iter().filter(|f| f.target == n.id).map(|f| f.id.as_str()).collect();
        let outgoing: Vec<&str> = bpmn.flows.iter().filter(|f| f.source == n.id).map(|f| f.id.as_str()).collect();
        if incoming.is_empty() && outgoing.is_empty() {
            out.push_str(&format!("    <{tag} id=\"{}\"{name_attr}/>\n", xml_escape(&n.id)));
            continue;
        }
        out.push_str(&format!("    <{tag} id=\"{}\"{name_attr}>\n", xml_escape(&n.id)));
        for f in incoming {
            out.push_str(&format!("      <incoming>{}</incoming>\n", xml_escape(f)));
        }
        for f in outgoing {
            out.push_str(&format!("      <outgoing>{}</outgoing>\n", xml_escape(f)));
        }
        out.push_str(&format!("    </{tag}>\n"));
    }

    for f in &bpmn.flows {
        let name_attr = f.label.as_deref().map(|l| format!(" name=\"{}\"", xml_escape(l))).unwrap_or_default();
        out.push_str(&format!(
            "    <sequenceFlow id=\"{}\" sourceRef=\"{}\" targetRef=\"{}\"{name_attr}/>\n",
            xml_escape(&f.id),
            xml_escape(&f.source),
            xml_escape(&f.target)
        ));
    }

    out.push_str("  </process>\n</definitions>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Flow, Metadata, Node, NodeKind, SourceType};

    #[test]
    fn exports_a_minimal_diagram() {
        let bpmn = Bpmn {
            nodes: vec![
                Node { id: "s".into(), kind: NodeKind::StartEvent, label: None },
                Node { id: "t".into(), kind: NodeKind::Task, label: Some("A".into()) },
                Node { id: "e".into(), kind: NodeKind::EndEvent, label: None },
            ],
            flows: vec![
                Flow { id: "f1".into(), source: "s".into(), target: "t".into(), label: None },
                Flow { id: "f2".into(), source: "t".into(), target: "e".into(), label: None },
            ],
            metadata: Metadata::clean(SourceType::ProcessTree),
        };
        let xml = export_bpmn_xml(&bpmn, "Process_1");
        assert!(xml.contains("<task id=\"t\" name=\"A\">"));
        assert!(xml.contains("sourceRef=\"s\" targetRef=\"t\""));
        assert!(!xml.contains("bpmndi"));
    }
}
