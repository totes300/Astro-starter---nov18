import { counted } from "~/features/i18n/grammar";
import type { UiStrings } from "~/features/i18n/strings";

// The Italian UI copy, registered under `it` in `strings.ts`. Named `italian` because `it` is node:test's.

const characters = counted("it", "carattere", "caratteri");

export const italian: UiStrings = {
  home: "Home",
  notFound: "Pagina non trovata",
  languageNav: "Lingua",

  landmark: {
    primary: "Principale",
    footer: "Piè di pagina",
  },

  footer: {
    site: "Sito",
    legal: "Note legali",
    contact: "Contatti",
  },

  control: {
    close: "Chiudi",
    menu: "Menu",
    closeAuthor: "Chiudi il profilo dell'autore",
    dismissAnnouncement: "Chiudi l'avviso",
    playVideo: "Riproduci il video",
    pauseVideo: "Metti in pausa il video",
    filterBy: (label) => `Filtra per ${label}`,
    removeFilter: (label) => `Rimuovi il filtro: ${label}`,
  },

  list: {
    articleCount: counted("it", "articolo", "articoli"),
    // "in" agrees with any count, where "corrispondenti" would not with one article.
    matching: (results, names) => `${results} in ${names}`,
    filterByCategory: "Filtra per categoria",
    noArticles: "Nessun articolo pubblicato per ora.",
    noMatchingArticles: "Nessun articolo corrisponde alle categorie selezionate.",
    byline: (names) => `Di ${names}`,
  },

  article: {
    minRead: (minutes) => `${minutes} min di lettura`,
  },

  author: {
    backTo: (title) => `Torna a ${title}`,
    articles: "Articoli",
  },

  blog: {
    fallbackTitle: "Blog",
  },

  feed: {
    rss: "RSS",
    description: (title) => `Le ultime novità da ${title}.`,
    untitled: "Senza titolo",
  },

  form: {
    sending: "Invio in corso",
    done: "Inviato",
    error: "Si è verificato un errore. Riprova.",
    closed: "Al momento non è possibile inviare il modulo. Riprova tra poco.",
    submitUnconfirmed: "La richiesta potrebbe esserci già arrivata. Attendi qualche istante prima di inviarla di nuovo.",
    submitFailed: "Invio del modulo non riuscito. Riprova più tardi.",
    needsJavaScript: "Per inviare questo modulo serve JavaScript.",
    dialCode: (label) => `${label}: prefisso internazionale`,
    humanCheckFailed: "Non siamo riusciti a confermare che sei una persona. Riprova.",
  },

  contactForm: {
    labels: {
      firstName: "Nome",
      lastName: "Cognome",
      email: "Email",
      phone: "Telefono",
      topic: "Argomento",
      startDate: "Data di inizio preferita",
      budget: "Budget",
      services: "Servizi",
      message: "Messaggio",
      consent: "Acconsento al trattamento dei miei dati personali come descritto nell'informativa sulla privacy",
    },
    options: {
      topic: { general: "Informazioni generali", project: "Nuovo progetto", support: "Assistenza" },
      budget: { "under-10k": "Meno di 10.000 $", "10k-50k": "Da 10.000 a 50.000 $", "over-50k": "Oltre 50.000 $" },
      services: { design: "Design", development: "Sviluppo", content: "Contenuti", seo: "SEO" },
    },
    send: "Invia messaggio",
    sent: "Messaggio inviato",
    success: "Grazie! Il tuo messaggio è stato inviato.",
    validation: {
      firstNameRequired: "Il nome è obbligatorio",
      firstNameTooLong: (max) => `Il nome può contenere al massimo ${characters(max)}`,
      lastNameRequired: "Il cognome è obbligatorio",
      lastNameTooLong: (max) => `Il cognome può contenere al massimo ${characters(max)}`,
      emailRequired: "L'email è obbligatoria",
      emailTooLong: (max) => `L'email può contenere al massimo ${characters(max)}`,
      emailInvalid: "Indirizzo email non valido",
      dialCodeInvalid: "Scegli un prefisso",
      phoneInvalid: "Il numero di telefono può contenere solo cifre e separatori",
      phoneTooLong: (max) => `Il numero di telefono può contenere al massimo ${characters(max)}`,
      topicRequired: "Scegli un argomento",
      dateInvalid: "Inserisci una data valida",
      servicesRequired: "Scegli almeno un servizio",
      servicesDuplicate: "Scegli ogni servizio una sola volta",
      messageRequired: "Il messaggio è obbligatorio",
      messageTooShort: (min) => `Il messaggio deve contenere almeno ${characters(min)}`,
      messageTooLong: (max) => `Il messaggio può contenere al massimo ${characters(max)}`,
      consentRequired: "Accetta l'informativa sulla privacy per continuare",
    },
  },
};
