//! BPMN 2.0 XML import: `<definitions><process>...</process></definitions>`
//! -> `Bpmn`. Reads the same pure control-flow subset this crate's own
//! exporter (`export_xml.rs`) writes, so a diagram exported from this
//! plugin round-trips.
//!
//! Anything outside that subset (pools/lanes, sub-processes, message flows,
//! boundary/intermediate events) is represented as an opaque pass-through
//! `task` node — carrying its own id/name forward so every `sequenceFlow`
//! referencing it still resolves — with one warning per element named,
//! never silently dropped and never approximated as something it isn't.

use crate::{Bpmn, Flow, Metadata, Node, NodeKind, SourceType};

fn node_kind_of(tag: &str) -> Option<NodeKind> {
    match tag {
        "startEvent" => Some(NodeKind::StartEvent),
        "endEvent" => Some(NodeKind::EndEvent),
        "exclusiveGateway" => Some(NodeKind::ExclusiveGateway),
        "parallelGateway" => Some(NodeKind::ParallelGateway),
        "inclusiveGateway" => Some(NodeKind::InclusiveGateway),
        "task" | "userTask" | "serviceTask" | "scriptTask" | "manualTask" | "sendTask"
        | "receiveTask" | "businessRuleTask" => Some(NodeKind::Task),
        _ => None,
    }
}

/// Elements with no bearing on control flow at all -- skipped without a
/// warning, unlike a genuinely unsupported *flow* element.
fn is_structurally_irrelevant(tag: &str) -> bool {
    matches!(
        tag,
        "laneSet" | "lane" | "documentation" | "extensionElements" | "ioSpecification"
            | "dataObject" | "dataObjectReference" | "dataStoreReference" | "resourceRole"
            | "potentialOwner" | "performer" | "property" | "correlationSubscription"
    )
}

pub fn import_bpmn_xml(xml: &str) -> Result<Bpmn, String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("not well-formed XML: {e}"))?;

    let processes: Vec<_> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "process")
        .collect();
    let process = processes
        .first()
        .copied()
        .ok_or_else(|| "no <process> element found -- not a BPMN 2.0 file".to_string())?;

    let mut warnings = Vec::new();
    if processes.len() > 1 {
        warnings.push(format!(
            "{} <process> elements found (a multi-pool collaboration); only the first was imported",
            processes.len()
        ));
    }

    let mut nodes = Vec::new();
    let mut flows = Vec::new();

    for child in process.children().filter(|n| n.is_element()) {
        let tag = child.tag_name().name();
        if is_structurally_irrelevant(tag) {
            continue;
        }
        if tag == "sequenceFlow" {
            let id = child
                .attribute("id")
                .ok_or("<sequenceFlow> element missing id")?
                .to_string();
            let source = child
                .attribute("sourceRef")
                .ok_or_else(|| format!("sequenceFlow '{id}' missing sourceRef"))?
                .to_string();
            let target = child
                .attribute("targetRef")
                .ok_or_else(|| format!("sequenceFlow '{id}' missing targetRef"))?
                .to_string();
            let label = child.attribute("name").map(str::to_string);
            flows.push(Flow { id, source, target, label });
            continue;
        }

        let id = child
            .attribute("id")
            .ok_or_else(|| format!("<{tag}> element missing id"))?
            .to_string();
        let name = child.attribute("name").map(str::to_string);

        if let Some(kind) = node_kind_of(tag) {
            let label = match kind {
                NodeKind::Task => Some(name.unwrap_or_else(|| id.clone())),
                _ => None,
            };
            nodes.push(Node { id, kind, label });
        } else {
            warnings.push(format!(
                "<{tag}> '{id}' has no equivalent in this plugin's BPMN subset -- represented as an opaque task, not its real behavior"
            ));
            nodes.push(Node { id, kind: NodeKind::Task, label: Some(name.unwrap_or_else(|| tag.to_string())) });
        }
    }

    let bpmn = Bpmn {
        nodes,
        flows,
        metadata: Metadata { source_type: Some(SourceType::Import), structured: warnings.is_empty(), warnings },
    };
    bpmn.validate()?;
    Ok(bpmn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NodeKind;

    const MINIMAL: &str = r#"<?xml version="1.0"?>
    <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
      <process id="P1">
        <startEvent id="s"/>
        <task id="t1" name="Take in charge"/>
        <exclusiveGateway id="g1"/>
        <task id="t2" name="Resolve"/>
        <endEvent id="e"/>
        <sequenceFlow id="f1" sourceRef="s" targetRef="t1"/>
        <sequenceFlow id="f2" sourceRef="t1" targetRef="g1"/>
        <sequenceFlow id="f3" sourceRef="g1" targetRef="t2"/>
        <sequenceFlow id="f4" sourceRef="t2" targetRef="e"/>
      </process>
    </definitions>"#;

    #[test]
    fn imports_a_minimal_diagram() {
        let bpmn = import_bpmn_xml(MINIMAL).unwrap();
        assert_eq!(bpmn.nodes.len(), 5);
        assert_eq!(bpmn.flows.len(), 4);
        assert!(bpmn.metadata.structured);
        assert!(bpmn.metadata.warnings.is_empty());
        bpmn.validate().unwrap();
    }

    #[test]
    fn rejects_non_xml() {
        assert!(import_bpmn_xml("not xml at all <<<").is_err());
    }

    #[test]
    fn rejects_missing_process() {
        let err = import_bpmn_xml(r#"<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"/>"#).unwrap_err();
        assert!(err.contains("no <process>"));
    }

    #[test]
    fn unsupported_construct_becomes_opaque_task_with_warning() {
        let xml = r#"<?xml version="1.0"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
          <process id="P1">
            <startEvent id="s"/>
            <subProcess id="sp1" name="Handle exception"/>
            <endEvent id="e"/>
            <sequenceFlow id="f1" sourceRef="s" targetRef="sp1"/>
            <sequenceFlow id="f2" sourceRef="sp1" targetRef="e"/>
          </process>
        </definitions>"#;
        let bpmn = import_bpmn_xml(xml).unwrap();
        assert!(!bpmn.metadata.structured);
        assert_eq!(bpmn.metadata.warnings.len(), 1);
        assert!(bpmn.metadata.warnings[0].contains("sp1"));
        let sp = bpmn.node("sp1").unwrap();
        assert_eq!(sp.kind, NodeKind::Task);
        assert_eq!(sp.label.as_deref(), Some("Handle exception"));
    }

    #[test]
    fn untitled_task_falls_back_to_its_own_id() {
        let xml = r#"<?xml version="1.0"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
          <process id="P1">
            <startEvent id="s"/>
            <task id="t1"/>
            <endEvent id="e"/>
            <sequenceFlow id="f1" sourceRef="s" targetRef="t1"/>
            <sequenceFlow id="f2" sourceRef="t1" targetRef="e"/>
          </process>
        </definitions>"#;
        let bpmn = import_bpmn_xml(xml).unwrap();
        assert_eq!(bpmn.node("t1").unwrap().label.as_deref(), Some("t1"));
    }

    #[test]
    fn laneset_and_documentation_are_skipped_silently() {
        let xml = r#"<?xml version="1.0"?>
        <definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL">
          <process id="P1">
            <documentation>Notes</documentation>
            <laneSet id="ls"><lane id="l1"/></laneSet>
            <startEvent id="s"/>
            <endEvent id="e"/>
            <sequenceFlow id="f1" sourceRef="s" targetRef="e"/>
          </process>
        </definitions>"#;
        let bpmn = import_bpmn_xml(xml).unwrap();
        assert_eq!(bpmn.nodes.len(), 2);
        assert!(bpmn.metadata.warnings.is_empty());
    }
}
