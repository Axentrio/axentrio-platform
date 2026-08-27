import type React from "react";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Modal } from "@/components/Modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Loader2,
  Upload,
  FileText,
  HelpCircle,
  FileType,
  X,
  CheckCircle2,
  Globe,
  Cloud,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { normalizeWebsiteUrl } from "@/lib/websiteUrl";
import {
  useCreateDocument,
  useUpdateDocument,
  useUploadFile,
  useImportWebsite,
  useDiscoverWebsiteHosts,
  type DiscoveredWebsiteHost,
} from "@/queries/useKnowledgeQueries";
import { useHasFeature } from "@/queries/useEntitlementsQueries";
import CloudImportPanel from "./CloudImportPanel";

type DocType = "text" | "faq" | "pdf" | "docx" | "url";
type ModalKind = DocType | "cloud";

interface AddDocumentModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingDocument?: {
    id: string;
    type: DocType;
    title: string;
    sourceContent?: string | null;
    storagePath?: string | null;
  } | null;
}

const docTypes: {
  value: ModalKind;
  labelKey: string;
  descriptionKey: string;
  icon: React.ElementType;
  accent: string;
}[] = [
  {
    value: "text",
    labelKey: "ai.knowledge.docTypes.text.label",
    descriptionKey: "ai.knowledge.docTypes.text.description",
    icon: FileText,
    accent: "border-violet-500/40 bg-violet-500/5 text-violet-400",
  },
  {
    value: "faq",
    labelKey: "ai.knowledge.docTypes.faq.label",
    descriptionKey: "ai.knowledge.docTypes.faq.description",
    icon: HelpCircle,
    accent: "border-amber-500/40 bg-amber-500/5 text-amber-400",
  },
  {
    value: "pdf",
    labelKey: "ai.knowledge.docTypes.pdf.label",
    descriptionKey: "ai.knowledge.docTypes.pdf.description",
    icon: FileType,
    accent: "border-rose-500/40 bg-rose-500/5 text-rose-400",
  },
  {
    value: "docx",
    labelKey: "ai.knowledge.docTypes.docx.label",
    descriptionKey: "ai.knowledge.docTypes.docx.description",
    icon: FileType,
    accent: "border-blue-500/40 bg-blue-500/5 text-blue-400",
  },
  {
    value: "url",
    labelKey: "ai.knowledge.docTypes.url.label",
    descriptionKey: "ai.knowledge.docTypes.url.description",
    icon: Globe,
    accent: "border-emerald-500/40 bg-emerald-500/5 text-emerald-400",
  },
  {
    value: "cloud",
    labelKey: "ai.knowledge.docTypes.cloud.label",
    descriptionKey: "ai.knowledge.docTypes.cloud.description",
    icon: Cloud,
    accent: "border-sky-500/40 bg-sky-500/5 text-sky-400",
  },
];

const MAX_FILE_SIZE = 25 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 500_000;

/** Document-type picker — shown only while creating a document. */
const DocTypeSelector: React.FC<{
  docType: ModalKind;
  canCloudImport: boolean;
  onSelect: (value: ModalKind) => void;
}> = ({ docType, canCloudImport, onSelect }) => {
  const { t } = useTranslation();
  const selectedType = docTypes.find((type) => type.value === docType)!;
  return (
    <div>
      <Label className="mb-2.5 text-text-secondary text-xs">
        {t("ai.knowledge.modal.fields.docType.label")}
      </Label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {docTypes
        .filter((type) => type.value !== "cloud" || canCloudImport)
        .map((type) => {
          const Icon = type.icon;
          const isSelected = docType === type.value;
          return (
            <button
              key={type.value}
              type="button"
              onClick={() => onSelect(type.value)}
              className={cn(
                "flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 transition-all text-center",
                isSelected
                  ? type.accent
                  : "border-transparent bg-surface-2 text-text-muted hover:bg-surface-3",
              )}
            >
              <Icon className="w-5 h-5" />
              <span className="text-xs font-medium">
                {t(type.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-text-muted mt-1.5">
        {t(selectedType.descriptionKey)}
      </p>
    </div>
  );
};

/** Title field — not used by the website and cloud imports, which name themselves. */
const TitleField: React.FC<{
  docType: ModalKind;
  title: string;
  onChange: (value: string) => void;
}> = ({ docType, title, onChange }) => {
  const { t } = useTranslation();
  if (docType === "url" || docType === "cloud") return null;
  return (
    <div>
      <Label className="mb-1.5 text-text-secondary text-xs">
        {t("ai.knowledge.modal.fields.title.label")}
      </Label>
      <Input
        value={title}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          docType === "faq"
            ? t("ai.knowledge.modal.fields.title.placeholder.faq")
            : docType === "pdf"
              ? t("ai.knowledge.modal.fields.title.placeholder.pdf")
              : t("ai.knowledge.modal.fields.title.placeholder.default")
        }
        required
      />
    </div>
  );
};

/** Website import: the start URL plus the extra hosts discovery offers. */
const WebsiteUrlField: React.FC<{
  websiteUrl: string;
  onUrlChange: (value: string) => void;
  isDiscovering: boolean;
  hosts: DiscoveredWebsiteHost[];
  selectedHosts: string[];
  onSelectedHostsChange: React.Dispatch<React.SetStateAction<string[]>>;
}> = ({
  websiteUrl,
  onUrlChange,
  isDiscovering,
  hosts,
  selectedHosts,
  onSelectedHostsChange,
}) => {
  const { t } = useTranslation();
  return (
    <div>
      <Label className="mb-1.5 text-text-secondary text-xs">
        {t("ai.knowledge.modal.fields.websiteUrl.label")}
      </Label>
      <Input
        type="text"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        value={websiteUrl}
        onChange={(e) => onUrlChange(e.target.value)}
        onBlur={() => {
          const next = normalizeWebsiteUrl(websiteUrl);
          if (next) onUrlChange(next);
        }}
        placeholder={t(
          "ai.knowledge.modal.fields.websiteUrl.placeholder",
        )}
        required
      />
      <p className="text-[10px] text-text-muted mt-1.5">
        {t("ai.knowledge.modal.fields.websiteUrl.helper")}
      </p>
      {isDiscovering && (
        <p className="text-[10px] text-text-muted mt-2">
          {t("ai.knowledge.modal.fields.extraHosts.looking")}
        </p>
      )}
      {!isDiscovering && hosts.length > 0 && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-text-secondary">
            {t("ai.knowledge.modal.fields.extraHosts.label")}
          </p>
          <p className="text-[10px] text-text-muted">
            {t("ai.knowledge.modal.fields.extraHosts.helper")}
          </p>
          {hosts.map((host) => {
            const checked = selectedHosts.includes(host.host);
            return (
              <label
                key={host.host}
                className="flex items-center gap-2 text-xs text-text-primary"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) => {
                    onSelectedHostsChange((prev) =>
                      value === true
                        ? [...prev, host.host]
                        : prev.filter((h) => h !== host.host),
                    );
                  }}
                />
                <span>{host.host}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
};

/** Drag-and-drop upload area for the PDF and DOCX types. */
const FileDropField: React.FC<{
  docType: ModalKind;
  file: File | null;
  onFileChange: (file: File | null) => void;
  title: string;
  onTitleChange: (title: string) => void;
}> = ({ docType, file, onFileChange, title, onTitleChange }) => {
  const { t } = useTranslation();
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) {
      onFileChange(dropped);
      if (!title) onTitleChange(dropped.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] || null;
    onFileChange(selected);
    if (selected && !title) onTitleChange(selected.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div>
      <Label className="mb-1.5 text-text-secondary text-xs">
        {t("ai.knowledge.modal.fields.file.label")}
      </Label>
      <div
        role="button"
        tabIndex={0}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onClick={() => !file && fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!file) fileInputRef.current?.click();
          }
        }}
        className={cn(
          "relative border-2 border-dashed rounded-xl transition-all overflow-hidden",
          file
            ? "border-emerald-500/30 bg-emerald-500/5 p-4"
            : isDragOver
              ? "border-primary-500 bg-primary-500/5 p-8 cursor-pointer"
              : "border-edge p-8 cursor-pointer hover:border-primary-500/40 hover:bg-surface-2",
        )}
      >
        {file ? (
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 shrink-0">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {file.name}
              </p>
              <p className="text-xs text-text-muted">
                {(file.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFileChange(null);
              }}
              className="p-1 rounded-md hover:bg-surface-3 text-text-muted shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="text-center">
            <div className="inline-flex p-3 rounded-xl bg-surface-2 mb-3">
              <Upload className="w-6 h-6 text-text-muted" />
            </div>
            <p className="text-sm text-text-secondary">
              {t("ai.knowledge.modal.fields.file.dropPrompt", {
                type: docType.toUpperCase(),
              })}{" "}
              <span className="text-primary-400 font-medium">
                {t("ai.knowledge.modal.fields.file.browse")}
              </span>
            </p>
            <p className="text-[10px] text-text-muted mt-1">
              {t("ai.knowledge.modal.fields.file.maxSize")}
            </p>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={docType === "pdf" ? ".pdf" : ".docx"}
          aria-label={t("ai.knowledge.modal.fields.file.label")}
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>
    </div>
  );
};

/** Free-text / FAQ body, with the length counter. */
const ContentField: React.FC<{
  docType: ModalKind;
  content: string;
  onChange: (value: string) => void;
}> = ({ docType, content, onChange }) => {
  const { t } = useTranslation();
  return (
    <div>
      <Label className="mb-1.5 text-text-secondary text-xs">
        {t("ai.knowledge.modal.fields.content.label")}
      </Label>
      <Textarea
        value={content}
        onChange={(e) => onChange(e.target.value)}
        placeholder={
          docType === "faq"
            ? t("ai.knowledge.modal.fields.content.placeholder.faq")
            : t("ai.knowledge.modal.fields.content.placeholder.default")
        }
        rows={10}
        required
        className="font-mono text-xs leading-relaxed"
      />
      {content.length > 0 && (
        <p
          className={cn(
            "text-[10px] mt-1 text-right",
            content.length > MAX_CONTENT_LENGTH * 0.9
              ? "text-amber-400"
              : "text-text-muted",
          )}
        >
          {content.length.toLocaleString()} /{" "}
          {MAX_CONTENT_LENGTH.toLocaleString()}
        </p>
      )}
    </div>
  );
};

/** Picks the body editor that matches the selected document type. */
const ContentSection: React.FC<{
  docType: ModalKind;
  isFileType: boolean;
  isEditing: boolean;
  title: string;
  onTitleChange: (value: string) => void;
  content: string;
  onContentChange: (value: string) => void;
  file: File | null;
  onFileChange: (file: File | null) => void;
  websiteUrl: string;
  onWebsiteUrlChange: (value: string) => void;
  isDiscovering: boolean;
  hosts: DiscoveredWebsiteHost[];
  selectedHosts: string[];
  onSelectedHostsChange: React.Dispatch<React.SetStateAction<string[]>>;
}> = ({
  docType,
  isFileType,
  isEditing,
  title,
  onTitleChange,
  content,
  onContentChange,
  file,
  onFileChange,
  websiteUrl,
  onWebsiteUrlChange,
  isDiscovering,
  hosts,
  selectedHosts,
  onSelectedHostsChange,
}) => {
  const { t } = useTranslation();
  if (docType === "cloud") return null;
  if (docType === "url") {
    return (
      <WebsiteUrlField
        websiteUrl={websiteUrl}
        onUrlChange={onWebsiteUrlChange}
        isDiscovering={isDiscovering}
        hosts={hosts}
        selectedHosts={selectedHosts}
        onSelectedHostsChange={onSelectedHostsChange}
      />
    );
  }
  if (isFileType && isEditing) {
    return (
      <div className="p-4 rounded-xl bg-surface-2 border border-edge">
        <p className="text-xs text-text-muted">
          {t("ai.knowledge.modal.fields.file.reuploadUnsupported")}
        </p>
      </div>
    );
  }
  if (isFileType) {
    return (
      <FileDropField
        docType={docType}
        file={file}
        onFileChange={onFileChange}
        title={title}
        onTitleChange={onTitleChange}
      />
    );
  }
  return (
    <ContentField
      docType={docType}
      content={content}
      onChange={onContentChange}
    />
  );
};

/** Cancel / submit row — the cloud import panel owns its own actions. */
const ModalActions: React.FC<{
  isCloudType: boolean;
  isEditing: boolean;
  isUrlType: boolean;
  isFileType: boolean;
  isSubmitting: boolean;
  title: string;
  content: string;
  websiteUrl: string;
  hasFile: boolean;
  onClose: () => void;
}> = ({
  isCloudType,
  isEditing,
  isUrlType,
  isFileType,
  isSubmitting,
  title,
  content,
  websiteUrl,
  hasFile,
  onClose,
}) => {
  const { t } = useTranslation();
  if (isCloudType) return null;
  const isIncomplete =
    (isUrlType ? !websiteUrl.trim() : !title.trim()) ||
    (!isFileType && !isUrlType && !content.trim()) ||
    (isFileType && !hasFile && !isEditing);
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end pt-1">
      <Button
        type="button"
        variant="ghost"
        onClick={onClose}
        disabled={isSubmitting}
      >
        {t("common.cancel")}
      </Button>
      <Button type="submit" disabled={isSubmitting || isIncomplete}>
        {isSubmitting && (
          <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
        )}
        {isEditing
          ? t("ai.knowledge.modal.actions.saveChanges")
          : isUrlType
            ? t("ai.knowledge.modal.actions.addWebsite")
            : t("ai.knowledge.modal.actions.addDocument")}
      </Button>
    </div>
  );
};

/** The modal heading depends on what is being added or edited. */
function resolveModalTitle(t: TFunction, isEditing: boolean, isUrlType: boolean): string {
  if (isEditing) return t("ai.knowledge.modal.edit.title");
  if (isUrlType) return t("ai.knowledge.modal.add.titleWebsite");
  return t("ai.knowledge.modal.add.title");
}

const AddDocumentModal: React.FC<AddDocumentModalProps> = ({
  isOpen,
  onClose,
  editingDocument,
}) => {
  const { t } = useTranslation();
  const canCloudImport = useHasFeature("cloudImport");
  const isEditing = !!editingDocument;
  const [docType, setDocType] = useState<ModalKind>("text");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [debouncedWebsiteUrl, setDebouncedWebsiteUrl] = useState("");
  const [selectedExtraHosts, setSelectedExtraHosts] = useState<string[]>([]);

  const createDoc = useCreateDocument();
  const updateDoc = useUpdateDocument();
  const uploadFile = useUploadFile();
  const importWebsite = useImportWebsite();
  const isUrlType = docType === "url";
  const isCloudType = docType === "cloud";
  const discover = useDiscoverWebsiteHosts(
    debouncedWebsiteUrl,
    isOpen && isUrlType,
  );

  const isSubmitting =
    createDoc.isPending ||
    updateDoc.isPending ||
    uploadFile.isPending ||
    importWebsite.isPending;
  const isFileType = docType === "pdf" || docType === "docx";

  // Populate / reset form fields whenever the modal opens or the editing
  // target changes — done during render (React's adjusting-state pattern) to
  // avoid the extra commit + stale-UI flash of an effect.
  const [syncKey, setSyncKey] = useState<string | null>(null);
  const currentKey = `${isOpen}:${editingDocument?.id ?? ""}`;
  if (syncKey !== currentKey) {
    setSyncKey(currentKey);
    if (editingDocument) {
      setDocType(editingDocument.type);
      setTitle(editingDocument.title);
      setContent(editingDocument.sourceContent || "");
      setFile(null);
      setWebsiteUrl("");
      setSelectedExtraHosts([]);
    } else {
      setDocType("text");
      setTitle("");
      setContent("");
      setFile(null);
      setWebsiteUrl("");
      setSelectedExtraHosts([]);
    }
  }

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedWebsiteUrl(websiteUrl.trim());
    }, 500);
    return () => window.clearTimeout(handle);
  }, [websiteUrl]);

  useEffect(() => {
    const hosts = discover.data?.hosts ?? [];
    setSelectedExtraHosts(hosts.filter((h) => h.autoCrawl).map((h) => h.host));
  }, [debouncedWebsiteUrl, discover.data]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isFileType && file && file.size > MAX_FILE_SIZE) {
      toast.error(t("ai.knowledge.modal.errors.fileTooLarge"));
      return;
    }
    if (!isFileType && !isUrlType && content.length > MAX_CONTENT_LENGTH) {
      toast.error(t("ai.knowledge.modal.errors.contentTooLong"));
      return;
    }

    if (!isEditing && isUrlType) {
      const extraUrls = discover.isFetched
        ? selectedExtraHosts.map((host) => `https://${host}/`)
        : undefined;
      importWebsite.mutate(
        {
          url: websiteUrl.trim(),
          followLinks: true,
          extraUrls,
        },
        { onSuccess: onClose },
      );
      return;
    }

    if (isEditing) {
      updateDoc.mutate(
        {
          id: editingDocument!.id,
          data: { title, sourceContent: isFileType ? undefined : content },
        },
        { onSuccess: onClose },
      );
      return;
    }

    if (isFileType && file) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await uploadFile.mutateAsync(file);
        const token = (result as any)?.uploadToken;
        createDoc.mutate(
          { type: docType, title, uploadToken: token },
          { onSuccess: onClose },
        );
      } catch {
        // uploadFile.onError already shows toast
      }
    } else {
      createDoc.mutate(
        { type: docType, title, sourceContent: content },
        { onSuccess: onClose },
      );
    }
  };

  const handleSelectType = (value: ModalKind) => {
    setDocType(value);
    setFile(null);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={resolveModalTitle(t, isEditing, isUrlType)}
      size="md"
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Document Type Selector */}
        {!isEditing && (
          <DocTypeSelector
            docType={docType}
            canCloudImport={canCloudImport}
            onSelect={handleSelectType}
          />
        )}

        {isCloudType && !isEditing && (
          <CloudImportPanel onImported={onClose} />
        )}

        {/* Title */}
        <TitleField docType={docType} title={title} onChange={setTitle} />

        {/* Content Area */}
        <ContentSection
          docType={docType}
          isFileType={isFileType}
          isEditing={isEditing}
          title={title}
          onTitleChange={setTitle}
          content={content}
          onContentChange={setContent}
          file={file}
          onFileChange={setFile}
          websiteUrl={websiteUrl}
          onWebsiteUrlChange={setWebsiteUrl}
          isDiscovering={discover.isFetching}
          hosts={discover.data?.hosts ?? []}
          selectedHosts={selectedExtraHosts}
          onSelectedHostsChange={setSelectedExtraHosts}
        />

        {/* Actions */}
        <ModalActions
          isCloudType={isCloudType}
          isEditing={isEditing}
          isUrlType={isUrlType}
          isFileType={isFileType}
          isSubmitting={isSubmitting}
          title={title}
          content={content}
          websiteUrl={websiteUrl}
          hasFile={!!file}
          onClose={onClose}
        />
      </form>
    </Modal>
  );
};

export default AddDocumentModal;
